/**
 * **决策区的高度契约** —— 四条判据 + 一条人造校准。
 *
 * ## 这份守卫守的是什么（2026-10-17 重写）
 *
 * 这块版面先后试过四种分配方式，**前三种都失败了，原因不是数值**：
 * ```
 *   ① max-h-[38vh]   → 工作流 429px、决策区 123px（装不下一条）
 *   ② max-h-[45%]    → 决策区仍是"一条装饰"
 *   ③ min-h-[180px]  → 决策区 180px，而面板内容区 556px（32%）
 * ```
 * 根因是**结构性的**：两者是同一个纵向 flex 里的兄弟节点，
 * 一方多拿一分高度，另一方就少一分 —— **任何百分比都只是换个牺牲者**。
 *
 * ## 现行契约：二选一（同一时间只渲染一个）
 *
 * ```
 *   团队模式：pane === 'decisions'  → 只渲染决策区，拿 flex-1（全部高度）
 *            pane === 'workflow'   → 只渲染工作流，决策区**不渲染**
 *   其它模式：决策区无条件 flex-1（**逐字节不变** —— 见下面那个事故）
 * ```
 *
 * ⚠️ **为什么必须有这条守卫**：`#10`（ai_managed）曾因为"只想着团队模式"被压成 10%、
 * 下面一大片空白。那条事故的教训是「**只在某模式下存在的东西，不能让它在别的模式下产生副作用**」。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const SRC = readFileSync(new URL('./DecisionFeed.tsx', import.meta.url), 'utf8');

/** 验收里的下限（一条最简决策行 72px + 标题 + 提示）；期望值独立写死，不从实现派生。 */
const MIN_HEIGHT_FLOOR_PX = 168;

test('★★★ 团队模式必须按 `pane` 二选一 —— 两块不能同时渲染', () => {
  const code = codeOnly(SRC);

  /*
   * 决策区必须有 `pane` 条件（否则它就和工作流区同时存在于 DOM 里 ⇒ 回到"争高度"）。
   * 两种合法写法都在代码里出现过：
   *   `!(mode === 'ai_team' && pane !== 'decisions')`  —— 早一版
   *   `pane === 'decisions'`                            —— 现版
   * 这里断言的是**语义**：代码里必须出现 `pane` 这个变量参与决策区的条件。
   */
  assert.ok(
    /pane\s*[!=]==\s*'decisions'/.test(code),
    '★ 决策区的渲染条件里必须出现 `pane` —— 否则它会和工作流区同时渲染，回到"两块争高度"',
  );
});

test('★★★ 团队模式的工作流区必须有反向条件 —— 否则两块同时渲染', () => {
  const code = codeOnly(SRC);
  assert.ok(
    /pane\s*[!=]==\s*'workflow'/.test(code),
    '★ 工作流区的渲染条件里必须出现 `pane` —— 否则它和决策区会一起渲染',
  );
});

test('★★★ 旧的纯 `max-h-[10%]` / `max-h-[max(10%` 形态不得回来（那是 UI-02 的缺陷形态）', () => {
  const code = codeOnly(SRC);
  /*
   * 这两串出现过两次，两次都让决策区只剩 56–180px：
   *   `max-h-[10%]`            → 900px 视口上 56px
   *   `max-h-[max(10%,180px)]` → 180px（32%）
   * 二选一之后**不需要任何百分比**（各拿全部高度），所以这两串都不该再出现。
   */
  assert.equal(code.includes('max-h-[10%]'), false, '★ `max-h-[10%]` 是"决策区只剩 56px"的原始形态');
  assert.equal(code.includes('max-h-[max(10%'), false, '★ `max-h-[max(10%,180px)]` 是 180px 的中间形态');
});

/**
 * 取「决策滚动区的 class 表达式」那一段源码。
 *
 * ## 为什么必须**先定位**，不能全文 `code.includes("'flex-1'")`
 *
 * 那是本仓库踩过两次的**同族坑**：判据锚在**源码文本的写法**上。
 * `t89` 给这个滚动区补回高度上限时，那句 class 从裸 `'flex-1'`
 * 变成了 `'max-h-[calc(100dvh-16rem)] flex-1 xl:max-h-none'` ——
 * **语义一点没变**（还是吃满全部可用高度），但断言找不到字面量 `'flex-1'` 就直接报红。
 * （同族：`t80` 改了 `routedModel.ts` 的 `onStep`，`toolLoopRouting.test.ts` 的正则失效。）
 *
 * 所以改成：先按**签名类**定位（`space-y-2.5` + `overflow-y-auto` —— 全文件只有
 * 决策滚动区同时有这两个），再取**那一个 `cn(...)` 调用**，在它里面按类名语义判 flex。
 * 定位不到就**响亮地失败**（`assert.ok(... !== null)`），而不是悄悄放过。
 *
 * ## 为什么是括号配对，而不是"往后取 N 个字符"
 *
 * ⚠️ `codeOnlyCss()` 把注释**原位替换成等长空白**（保留换行，好让报错行号对得上）——
 * 实测：决策区那句 `cn(...)` 里夹着一段约 2.5KB 的注释，于是"往后取 200 字符"
 * **根本够不到** `flex-1` 那个字符串（第一次写就是栽在这里，test 4 假红）。
 * 而简单地放大到 4000 字符又会越过这个调用的边界、把**别的**元素（比如工作流区）
 * 的 `flex-1` 也算进来 —— 那会让判据**恒真**。
 * 所以按括号配对**只取这一个调用**，并且**跳过字符串内部**（`calc(` 里的括号
 * 不能参与配对）。
 */
function feedClassWindow(code: string): string | null {
  const at = code.indexOf('space-y-2.5 overflow-y-auto');
  if (at < 0) return null;
  const open = code.lastIndexOf('cn(', at);
  if (open < 0) return null;

  let depth = 0;
  let quote: string | null = null;
  for (let i = open + 3; i < code.length; i += 1) {
    const ch = code[i];
    if (quote !== null) {
      /* 字符串内部：括号不算括号，只等它的收尾引号。 */
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return code.slice(at, i);
      depth -= 1;
    }
  }
  return null;
}

/** 类名必须**独立成词**才算命中（`flex-1` 不能被 `flex-10` 之类蒙混过去）。 */
function hasClassToken(window: string, cls: string): boolean {
  return new RegExp(`(^|[\\s'"])${cls}([\\s'"]|$)`).test(window);
}

test('★★★ 决策区必须拿 `flex-1`（全部可用高度），不能是 `flex-none`', () => {
  const code = codeOnly(SRC);
  /*
   * 二选一之后决策区独占那一片，所以它必须是 `flex-1`。
   * `flex-none` 会让它按内容高度收缩 —— 那一轮没决策时就是一条缝（正是 UI-02 的形态）。
   *
   * ⚠️ **判据按语义，不按写法**（见 `feedClassWindow` 的说明）：
   * `'flex-1'` 和 `'max-h-[…] flex-1 xl:max-h-none'` **都算通过** ——
   * 前者是"父级已给确定高度"的形态，后者是"父级高度是 auto"时的形态，
   * 两者都让决策区吃满全部可用高度。**判的是"有没有 flex-1 这一类"**。
   */
  const window = feedClassWindow(code);
  assert.ok(
    window !== null,
    '★ 找不到决策滚动区的 class 表达式（签名类 `space-y-2.5 overflow-y-auto`）—— 结构变了就必须更新这条守卫',
  );
  assert.ok(hasClassToken(window, 'flex-1'), '★ 决策区的 class 里必须有 `flex-1` —— 它要吃掉全部可用高度');
  assert.equal(
    hasClassToken(window, 'flex-none'),
    false,
    '★ 决策区的 class 里不得有 `flex-none` —— 那是"决策区按内容收缩"的旧形态',
  );
});

test('★★★ 新判据（按语义判 flex）必须对"变成 flex-none"变红 —— 人造源码校准', () => {
  /*
   * ⚠️ **这一条是为了防止我把真守卫换成一个恒真判据**（本轮改判据时必做的校准）。
   *
   * 三个方向都要验到：
   *   ① 缺陷形态（决策区 `flex-none`）→ 必须**判红**
   *   ② 两种合法写法 → 必须**判过**（否则守卫会误伤正确实现）
   *   ③ `flex-10` 不能被当成 `flex-1`（防"子串命中"型恒真）
   */
  const windowOf = (src: string): string | null => feedClassWindow(codeOnly(src));

  /* ① 决策区变成 flex-none（"按内容收缩"的旧形态） */
  const flexNone = windowOf(`className={cn('min-h-0 space-y-2.5 overflow-y-auto p-2.5', 'flex-none')}`);
  assert.ok(flexNone !== null, '★ 定位必须能找到决策滚动区');
  assert.equal(hasClassToken(flexNone, 'flex-1'), false, '★ flex-none 形态必须判成"没有 flex-1"');
  assert.equal(hasClassToken(flexNone, 'flex-none'), true, '★ flex-none 形态必须被判红');

  /* ② 两种合法写法都过：裸 `'flex-1'`（父级有确定高度）与带高度上限的那种 */
  const goodSamples = [
    `className={cn('min-h-0 space-y-2.5 overflow-y-auto p-2.5', 'flex-1')}`,
    `className={cn('min-h-0 space-y-2.5 overflow-y-auto p-2.5', 'max-h-[calc(100dvh-16rem)] flex-1 xl:max-h-none')}`,
  ];
  for (const good of goodSamples) {
    const w = windowOf(good);
    assert.ok(w !== null, '★ 定位必须能找到决策滚动区');
    assert.ok(hasClassToken(w, 'flex-1'), `★ 合法写法必须通过：${good}`);
    assert.equal(hasClassToken(w, 'flex-none'), false, `★ 合法写法不得被判成 flex-none：${good}`);
  }

  /* ③ 子串陷阱：`flex-10` 含 `flex-1` 四个字符，但不是 `flex-1` */
  const flexTen = windowOf(`className={cn('min-h-0 space-y-2.5 overflow-y-auto p-2.5', 'flex-10')}`);
  assert.ok(flexTen !== null, '★ 定位必须能找到决策滚动区');
  assert.equal(hasClassToken(flexTen, 'flex-1'), false, '★ `flex-10` 不是 `flex-1`（判据必须按类名整词匹配）');
});

test('★★ 判据必须真的能报出缺陷形态 —— 用人造源码校准', () => {
  /*
   * ⚠️ 校准的意义：如果上面四条对任何输入都为真，它们就是**恒真的装饰**。
   * 这里把历史缺陷形态人造出来，断言「守卫会拒绝它」。
   *
   * 注意：校准对象是**字符串**，不读真实文件 —— 所以它不会因为实现改动而失效。
   */
  const badSamples = [
    // ① 纯百分比（900px 视口上 56px）
    `className={cn('min-h-0 space-y-2.5 overflow-y-auto p-2.5', mode === 'ai_team' ? 'flex-none max-h-[10%]' : 'flex-1')}`,
    // ② 中间形态（180px / 32%）
    `className={cn('min-h-0', mode === 'ai_team' ? 'flex-none min-h-[180px] max-h-[max(10%,180px)]' : 'flex-1')}`,
    // ③ 没有 pane 条件（两块同时渲染）
    `{mode === 'ai_team' && (<div>工作流</div>)}<div className="flex-1">决策</div>`,
  ];

  for (const bad of badSamples) {
    const code = codeOnly(bad);
    const hasOldPercent = code.includes('max-h-[10%]') || code.includes('max-h-[max(10%');
    const hasFlexNone = /'flex-none[^']*'/.test(code);
    const hasPane = /pane\s*[!=]==\s*'decisions'/.test(code);
    assert.ok(
      hasOldPercent || hasFlexNone || !hasPane,
      `★★ 人造缺陷没有被任何判据拒绝 —— 判据失效了：\n${bad}`,
    );
  }
});
