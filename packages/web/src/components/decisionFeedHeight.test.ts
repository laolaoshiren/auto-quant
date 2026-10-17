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

test('★★★ 决策区必须拿 `flex-1`（全部可用高度），不能是 `flex-none`', () => {
  const code = codeOnly(SRC);
  /*
   * 二选一之后决策区独占那一片，所以它必须是 `flex-1`。
   * `flex-none` 会让它按内容高度收缩 —— 那一轮没决策时就是一条缝（正是 UI-02 的形态）。
   */
  const idx = code.indexOf("'flex-1'");
  assert.ok(idx >= 0, '★ 找不到 `flex-1` —— 决策区应当吃掉全部可用高度');
  assert.equal(
    /'flex-none[^']*'/.test(code),
    false,
    '★ 不得出现 `flex-none` —— 那是"决策区按内容收缩"的旧形态',
  );
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
