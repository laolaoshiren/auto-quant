/**
 * **决策区的高度不能对非团队模式生效**（2026-10-13 实测回归）。
 *
 * ## 事故：`#10 赚大钱`（ai_managed）的右栏变成一大片空白
 *
 * 用户截图：右栏「最近决策」里只有一行 `NEARUSDT`，下面是整屏空白。
 *
 * ## 根因：我为团队模式压决策区，却压到了所有模式
 *
 * 上一轮为了让「AI 工作流」占主导，我把决策记录区改成：
 * ```
 *   max-h-[10%] + flex-none
 * ```
 * 而**工作流区只在 `ai_team` 渲染** —— 于是：
 * ```
 *   ai_team    : 工作流 flex-1（吃满）+ 决策区 10%   ✅ 符合预期
 *   ai_managed : 工作流【不存在】+ 决策区 10%        ❌ 90% 空白
 * ```
 * 浏览器实测（`#4` 非团队模式）：
 * ```
 *   修前：子节点 h=66（视口的 10%）→ 空白
 *   修后：子节点 h=656（满高）· 3 条决策卡正常渲染
 * ```
 *
 * ## 教训
 *
 * **「只在某模式下存在的东西，不能让它在别的模式下产生副作用」** ——
 * 这个面板是**三种模式共用**的（`strategy` / `ai_managed` / `ai_team`），
 * 改它时必须逐模式想一遍。
 *
 * ## ⚠️ 2026-10-17 第二次修正：`10%` 本身也是错的（台账 UI-02）
 *
 * 上面那条修好之后，"团队模式压到 10%" 被当成了正确答案。t3 用真实浏览器量到：
 * ```
 *   面板内容区 560px → 决策区 h=56px（=10%）
 *   而一轮决策卡高 82–300px，展开一轮后内容 1040px
 *   → 用户要的"下面滚动展示最终决策"变成了"露出两个字"
 *   → Playwright 连被裁出滚动区的卡片按钮都判成 not visible（60 次重试超时）
 * ```
 * 所以契约从"**按模式分开**"升级为"**按模式分开 + 团队模式要有内容下限**"：
 * ```
 *   非团队   : flex-1                        （吃掉全部高度，和改动前一致）
 *   团队模式 : min-h-[Npx]（N ≥ 168）        （不再是一个纯百分比）
 * ```
 * 下面三条断言按**新契约**写：三元必须还在、非团队必须仍是 `flex-1`、
 * 团队分支必须有 ≥168px 的下限、且**旧的纯 `max-h-[10%]` 形态不得回来**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const SRC = readFileSync(new URL('./DecisionFeed.tsx', import.meta.url), 'utf8');

/** 验收里的下限（台账 UI-02：`clientHeight ≥ 168`）；期望值独立写死，不从实现派生。 */
const MIN_HEIGHT_FLOOR_PX = 168;

/** 从源码里取出团队分支的 `min-h-[Npx]`。 */
function teamMinHeight(code: string): number | null {
  const teamBranch = code.slice(code.indexOf("mode === 'ai_team' ?"));
  const m = teamBranch.match(/min-h-\[(\d+)px\]/);
  return m ? Number(m[1]) : null;
}

test('★★★ 决策区的高度必须按 `mode` 分开（不能无条件压）', () => {
  const code = codeOnly(SRC);
  assert.ok(
    /mode === 'ai_team' \?\s*'[^']*min-h-\[/.test(code),
    '★ 必须是"团队模式（带下限）、其它模式 flex-1"的三元 —— 无条件压会让非团队模式空出 90%',
  );
});

test('★★★ 团队模式的决策区必须有 ≥168px 的内容下限（台账 UI-02）', () => {
  const code = codeOnly(SRC);
  const floor = teamMinHeight(code);
  assert.ok(floor !== null, '★ 团队分支必须写 `min-h-[Npx]` —— 纯百分比在 900px 视口上只剩 56px');
  assert.ok(
    floor >= MIN_HEIGHT_FLOOR_PX,
    `★ 下限 ${floor}px 太小：验收要求 ≥ ${MIN_HEIGHT_FLOOR_PX}px（一条最简决策行 72px + 标题 + 提示）`,
  );
});

test('★★★ 旧的纯 `max-h-[10%]` 形态不得回来（那是 UI-02 的缺陷形态）', () => {
  const code = codeOnly(SRC);
  assert.equal(
    code.includes('max-h-[10%]'),
    false,
    '★ `max-h-[10%]` 是"决策区只剩 56px"的原始形态 —— 不要退回纯百分比',
  );
});

test('★★★ 非团队模式必须仍是 `flex-1`（吃掉全部高度）', () => {
  const code = codeOnly(SRC);
  assert.ok(
    code.includes(": 'flex-1'"),
    "★ 非团队模式的分支必须是 `flex-1`（否则决策区不会长高）",
  );
});

test('★★ 判据必须真的能报出缺陷形态 —— 用人造源码校准', () => {
  /* ① 旧形态（纯 10%，没有下限）→ 两条断言都必须报出来。 */
  const oldForm = "mode === 'ai_team' ? 'flex-none max-h-[10%]' : 'flex-1'";
  assert.equal(teamMinHeight(oldForm), null, '★ 旧形态必须被判成"没有下限"');
  assert.equal(/mode === 'ai_team' \?\s*'[^']*min-h-\[/.test(oldForm), false, '★ 旧形态必须判成不合格的三元');
  assert.equal(oldForm.includes('max-h-[10%]'), true, '★ 旧形态必须被"纯百分比"判据抓到');

  /* ② 下限太小 → 必须报（否则"随便写个 px"就能过）。 */
  const tooSmall = "mode === 'ai_team' ? 'flex-none min-h-[40px]' : 'flex-1'";
  assert.equal(teamMinHeight(tooSmall), 40, '★ 要能读出实际值');
  assert.ok(40 < MIN_HEIGHT_FLOOR_PX, '★ 40px 必须判成不合格（校准的是比较逻辑）');

  /* ③ 新形态 → 必须放过（不能把正确写法误判成违规）。 */
  const good = "mode === 'ai_team' ? 'flex-none min-h-[180px] max-h-[max(10%,180px)]' : 'flex-1'";
  assert.equal(teamMinHeight(good), 180);
  assert.equal(/mode === 'ai_team' \?\s*'[^']*min-h-\[/.test(good), true);
  assert.equal(good.includes('max-h-[10%]'), false, '★ 正确写法里不含纯百分比形态');
});
