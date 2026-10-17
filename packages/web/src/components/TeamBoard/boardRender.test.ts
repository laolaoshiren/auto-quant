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
import type { TeamStep } from './roster.js';

/**
 * 渲染看板。
 *
 * `steps` 可选 —— 传空是"其余岗位那一批要显示状态"的场景（默认）；
 * 传一步人造产出则用来验证**产出**那一格的渲染（见 markdown 剥除那条测试）。
 */
function renderBoard(steps: readonly TeamStep[] = []): string {
  return renderToStaticMarkup(
    createElement(TeamBoard, {
      steps,
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

test('★★★ 「随批运行」组：community_monitor / onchain_analyst 显示"随批运行"并写明承担物', () => {
  /*
   * ⚠️ **2026-10-17（t112）拆组**：原来这两个与下面那三个写在**同一个数组**里，
   * 一起断言"规划中" —— 而它们其实**真的在跑**（由批量调研的猎手承担）。
   *
   * 用户原话：「我观察到**很多岗位，似乎从未真正运行过**」——
   * 对这两个岗位，界面在**低估自己**：说"规划中（还没实现）"，
   * 而 `community_hunter` / `flow_hunter` 确实在做它们的活。
   *
   * 拆成两组之后守卫**比原来更精确**：原来那 5 个混在一起，
   * 掩盖了"有的在跑、有的真没跑"这个事实。
   */
  const html = renderBoard();
  const expected: Record<string, string> = {
    community_monitor: 'community_hunter',
    onchain_analyst: 'flow_hunter',
  };
  for (const [id, hunter] of Object.entries(expected)) {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 渲染结果里找不到 ${id} 那一行（判据失效，先修这个）`);
    const text = textOf(row);
    assert.ok(text.includes('随批运行'), `★★★ ${id} 由调研猎手承担，必须显示"随批运行"：${text}`);
    assert.ok(
      !text.includes('规划中'),
      `★★★ ${id} 还在显示"规划中" —— 那会让操作员以为根本没人干这件事：${text}`,
    );
    /* 承担物必须写出来（"随批运行"这句话本身无法被核对）。 */
    assert.ok(text.includes(hunter), `★★ ${id} 必须写明由哪个猎手承担（${hunter}）：${text}`);
  }
});

test('★★★ 「真未接线」组：red_team / portfolio_manager / clerk 仍显示"规划中"且无承担说明', () => {
  /*
   * 反方向：这三个**确实没有任何东西在替它们跑**（`t109` 的接线核对：0 调用点）。
   * 把它们也点亮就是另一种说谎，正是任务里明确警告的"下一次有人顺手全改"。
   *
   * ⚠️ 判据从原来的"5 个一起"收窄成这 3 个 —— **不是放松，是精确化**：
   * 那两个"随批运行"的由上面那条守，这里守的是"真没跑的那些不许被顺手点亮"。
   */
  const html = renderBoard();
  for (const id of ['red_team', 'portfolio_manager', 'clerk']) {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 渲染结果里找不到 ${id} 那一行（判据失效，先修这个）`);
    const text = textOf(row);
    assert.ok(text.includes('规划中'), `★ ${id} 的职责确实没在跑 —— 必须仍然显示"规划中"：${text}`);
    assert.ok(!text.includes('代码在跑'), `★ ${id} 不是 by_code 岗位，不能显示"代码在跑"：${text}`);
    assert.ok(!text.includes('随批运行'), `★★ ${id} 没有任何东西替它跑，不能显示"随批运行"：${text}`);
    /* 它也不该有承担说明 —— 有就说明有人顺手给它编了一个承担者。 */
    assert.ok(!text.includes('由猎手承担'), `★★ ${id} 没有承担者，不能有"由猎手承担"：${text}`);
  }
});

test('★★★ 行内（含 title 属性）不得残留 markdown 强调符', () => {
  /*
   * 用户 2026-10-15 的看板截图实测：界面上原样显示着
   * ```
   *   汇总多空论证，给出**唯一**结论（有权决定"不行动"）
   *   尽最大努力论证**做多**（并给出失效条件）
   * ```
   * 那些 `**` 是 `firm.ts` 的 `duty` 字段里**写给模型看的强调标记** ——
   * 而这里是给人读的纯文本，不是 markdown 渲染器。用户看到只会当成界面 bug。
   *
   * ⚠️ 判据取**整个行的 HTML**（不是剥完标签的文字）：职责现在挂在 `title` 属性上，
   * 只判可见文字会把"悬浮提示里还带着 `**`"这个漏网之鱼放过去。
   */
  const html = renderBoard();
  for (const id of ['judge', 'bull', 'bear', 'market_analyst', 'data_sentinel']) {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 渲染结果里找不到 ${id} 那一行（判据失效，先修这个）`);
    assert.ok(!row.includes('**'), `★ ${id} 那一行的 HTML 里还有 markdown 强调符：${row.slice(0, 180)}`);
  }
});

test('★★★ 本轮产出里的强调符同样要剥掉（真实模型输出常带 `**`）', () => {
  /*
   * 上一条只覆盖了 `duty`。而**产出**是模型写的自然语言 ——
   * 它带 `**` 的情形更多（`prompt.ts` 给模型的规则里就用 `**` 做强调）。
   *
   * 这条用一步**人造的**产出（带 `**`）渲染，直接证明 `plain()` 真的接在产出上：
   * 它是"含 `**` 的输入 → 渲染后不含 `**`"的正向判据，
   * 而不是"恰好那批数据里没有 `**`"的巧合。
   */
  const html = renderBoard([
    { at: new Date().toISOString(), level: 'info', role: 'judge', message: '理由(i)：**位移**不足，判 **不行动**。' },
  ]);
  const judgeRow = rowOf(html, 'judge');
  assert.ok(judgeRow.length > 0, '★ 切不到 judge 那一行（判据失效，先修这个）');
  const text = textOf(judgeRow);
  assert.ok(
    text.includes('位移不足') || text.includes('不行动'),
    `★ 这一步产出没有被渲染出来 —— 判据会退化成恒真：${text}`,
  );
  assert.ok(!text.includes('**'), `★ 产出里的强调符没被剥掉：${text}`);
});

test('★★★ 折叠态把横向空间让给"本轮产出"：行内不再渲染职责', () => {
  /*
   * ## 为什么这是一条**布局**守卫
   *
   * 2026-10-15 用真实浏览器量到的问题（`getBoundingClientRect` + `scrollWidth > clientWidth`）：
   * 一行里三个 `flex-1` 平分剩余宽度时 ——
   * ```
   *   职责      可用 142px / 需要 272px
   *   本轮产出  可用 142px / 需要 387px   ← 砍掉 63%
   * ```
   * 而"它这一轮在做什么"（产出）才是操作员看这个看板的目的。
   *
   * 改法是让职责让位：挂到 `role.label` 的 `title`（悬浮可见）、全文进展开态。
   *
   * SSR **量不到像素宽度**，但能钉住这个结构性决定：职责正文一旦回到行内，
   * 就说明有人又把宽度分给了它。
   *
   * ⚠️ **边界（诚实说明）**：这条只证明"职责不在折叠行的可见文字里"，
   * **不证明**产出的可见宽度真的变大了 —— 那要用真实浏览器量，SSR 做不到。
   * 也不覆盖展开态（`allOpen` 是组件内部 state，SSR 无法触发展开）。
   */
  const html = renderBoard();
  const judgeRow = rowOf(html, 'judge');
  const judgeText = textOf(judgeRow);
  assert.ok(judgeText.length > 0, '★ 切不到 judge 那一行（判据失效，先修这个）');
  assert.ok(
    !judgeText.includes('汇总多空论证'),
    `★ 职责回到了折叠行的可见文字里 —— 它会重新跟"本轮产出"抢宽度：${judgeText}`,
  );
  /*
   * 反方向：职责任然**可达** —— 它在 `title` 属性里（悬浮可见）。
   * 少了这一条，上面那句"职责不在行内"用"把职责整个删掉"也能通过。
   */
  assert.ok(
    judgeRow.includes('汇总多空论证'),
    '★ 职责被整个删掉了 —— 它必须仍然挂在 role.label 的 title 上（悬浮可见）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ★ t108：agent 层角色必须渲染成中文名（用户实测）                            */
/* -------------------------------------------------------------------------- */

test('★★★ 用户截图里那两个岗位（strategist / reviewer）渲染成中文名，不再是英文 id 与占位文案', () => {
  /*
   * 用户 2026-10-17 的原话：「AI 工作流里面有部分显示的是：**英文、占位符**，
   * 而不是正确的显示中文名称」。截图可见：
   * ```
   *   技术 2 个岗位
   *     ▼ strategist  进行中  分析  6 步
   *        职责：界面还没登记这个岗位的分工 —— 但它在工作（见右侧最近动作）。
   *     ▼ reviewer    进行中  分析  工具…
   * ```
   *
   * 这两个角色**不在编制表**（所以走 roster 的「编制表之外」兜底分支），
   * 而那条分支以前把 id 当标题。这条断言**直接钉住屏幕上那两行的字** ——
   * 常量表里有中文名**不等于**某一行真的渲染出了它。
   */
  const html = renderBoard([
    { at: '2026-10-17T04:00:00.000Z', message: '定方向', role: 'strategist', phase: 'analysis', level: 'info' },
    { at: '2026-10-17T04:00:05.000Z', message: '复核结论', role: 'reviewer', phase: 'analysis', level: 'info' },
  ]);
  const wanted: Record<string, string> = { strategist: '策略师', reviewer: '复核员' };
  for (const [id, want] of Object.entries(wanted)) {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 切不到 ${id} 那一行（判据失效，先修这个）`);
    const text = textOf(row);
    assert.ok(text.includes(want), `★ ${id} 那一行没有中文名「${want}」：${text.slice(0, 120)}`);
    /*
     * 反方向：英文 id **不能**再出现在这一行的可见文字里。
     * 用词边界匹配 —— `strategist` 不该命中 `strategists` 之类，也不该被
     * 中文名里的字误伤。
     */
    assert.ok(
      !new RegExp(`(^|\\s)${id}(\\s|$)`).test(text),
      `★ ${id} 那一行仍在显示英文 id —— 用户报的就是这个形状：${text.slice(0, 120)}`,
    );
  }
});

test('★★ 兜底文案不自责：不再对操作员说「界面还没登记」', () => {
  /*
   * 用户关心的是"它是谁"和"它到底在不在干活"，不是"你们界面没跟上"。
   *
   * ## ⚠️ 断言范围：搜索**整段 HTML**（含属性），不是 `textOf()` 的可见文字
   *
   * 第一版我照抄了上面几条的 `textOf(html)` —— 于是**假红**：
   * `duty` 在折叠态**根本不在可见文字里**（`TeamBoard.tsx:659` 的注释说明了原因：
   * 「职责刻意不在这里渲染」），它只出现在
   * ```
   *   :632  span 的 title 属性        （悬浮可见）
   *   :806  展开态的行内文字          （SSR 里是收起的）
   * ```
   * `textOf()` 会剥掉标签，于是连 `title` 属性内容一起丢掉 —— 那是**判据搜错了地方**。
   *
   * 所以这里直接在原始 HTML 上搜：既覆盖悬浮文案，也覆盖展开态。
   * 这个坑本文件第 88 行自己就写过一次（"搜错了地方，守卫会在两个方向上同时出错"）。
   */
  const html = renderBoard([
    { at: '2026-10-17T04:00:00.000Z', message: '干活', role: 'quantum_analyst', phase: 'analysis', level: 'info' },
  ]);
  assert.ok(!html.includes('界面还没登记'), '★ 旧的自责措辞又出现了（用户截图报过的形状）');
  assert.ok(!html.includes('界面未登记'), '★ 旧的自责措辞又出现了');
  assert.ok(
    html.includes('不在编制表里') && html.includes('正在工作'),
    '★ 兜底应当中性地说"不在编制表里但正在工作"（保留"它在干活"这个事实）',
  );
  /*
   * 探针：证明上面那三条搜的**确实是同一个文案字段**，而不是"整页碰巧没有这几个字"。
   * 用一个已知会出现在同一 docstring 里的短语做正向对照。
   */
  assert.ok(html.includes('见右侧最近动作'), '★ 探针失效：根本搜不到 duty 文案所在的属性，那三条断言是恒真的');
});

/* -------------------------------------------------------------------------- */
/*  ⑥ 「历史工作详情」入口（2026-10-17 · t111 · 用户原话）                        */
/* -------------------------------------------------------------------------- */

/**
 * **★★★ 用户要的那个按钮：每个已实现的岗位都要有，`planned` 不许有。**
 *
 * 用户原话：
 * > 「每个角色**增加一个可点击按钮，点击去以后能看他历史工作详情**」
 *
 * 原判据是 `stepCount > 0`（只有本轮跑过才有按钮），于是**本轮没叫到**的岗位
 * 连点都点不了 —— 而团队是按需出勤的，"这轮没叫它"是常态，
 * 用户最想查的恰恰是那些"看起来从未运行过"的岗位。
 *
 * ## 为什么 `planned` 不给按钮
 *
 * 给一个点开永远没有内容的按钮，等于让操作员以为"再等等就有数据"。
 * 而真相是这个岗位**没人实现**。所以它是唯一被排除的一类。
 *
 * ⚠️ 判据用 `aria-expanded` 属性而不是"有没有 `button` 元素"：
 * 一行里可能有别的按钮（未来的），而展开控件必须能被读屏识别。
 */
test('★★★ 每个已实现的岗位都有「历史详情」展开按钮，planed 的没有', () => {
  /*
   * 传空步骤 = **本轮谁都没跑**，这正是用户报"从未运行过"的那个场景。
   * 若判据还是 `stepCount > 0`，这里一个按钮都不会有 —— 那就是 bug 的形状。
   */
  const html = renderBoard();

  const expectButton = (id: string): void => {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 找不到 ${id} 那一行（判据失效，先修这个）`);
    assert.ok(
      row.includes('aria-expanded'),
      `★ ${id} 是本轮没参与但**已实现**的岗位 —— 它必须有展开按钮（用户要"点开看历史"）`,
    );
  };
  const expectNoButton = (id: string): void => {
    const row = rowOf(html, id);
    assert.ok(row.length > 0, `★ 找不到 ${id} 那一行（判据失效，先修这个）`);
    assert.ok(
      !row.includes('aria-expanded'),
      `★ ${id} 是 planned（根本没实现）—— 不该给它按钮：点开永远是空的，那是在骗操作员`,
    );
  };

  /* `staffed`：抽查那几个用户点名"似乎从未运行过"的。 */
  for (const id of ['supervisor', 'risk_officer', 'reporter', 'memory_curator']) expectButton(id);
  /* `by_code`：职责在跑、没有模型出勤 —— 也应该能点开（展开态会说明由哪段代码承担）。 */
  for (const id of ['data_sentinel', 'ops_watchdog']) expectButton(id);
  /*
   * `planned`：5 个 —— ⚠️ **2026-10-17（t112）起它们分成两类，但这条判据对两类都成立**：
   * ```
   *   随批运行（community_monitor / onchain_analyst）：职责由猎手承担，但**没有模型出勤记录**
   *   真未接线（red_team / portfolio_manager / clerk）：什么都没有
   * ```
   * 两类的 `status` **都是 `planned`**，而"能不能点开历史详情"的判据是
   * `role.status !== 'planned'`（`TeamBoard.tsx:711`）—— 所以两者都不给按钮。
   * **这是刻意的**：随批运行的岗位没有"轮次里的出勤"，点开只会是一个空面板。
   * 它的承担物已经写在行内（「由猎手承担：…」），不需要再开一个详情去说明。
   */
  for (const id of ['onchain_analyst', 'community_monitor', 'red_team', 'portfolio_manager', 'clerk']) {
    expectNoButton(id);
  }
});
