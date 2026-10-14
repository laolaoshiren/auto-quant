/**
 * **权益曲线必须和「账户余额」对得上**（2026-10-13，用户两次反馈后定稿）。
 *
 * ## 用户的两次反馈
 *
 * **第一次**：
 * > 「图表上显示和实际账号对不上」
 *
 * 我查到：曲线画 `equity`（归属口径 = `initial_equity + Σ本机器人已平仓净额`），
 * 而指标卡「账户余额」显示 `accountEquity`（共享钱包真实权益）。
 * 实测 `#10`：`108.47` vs `97.80`，差 `10.67` = 同钱包上 `#9`/`#11` 的亏损。
 *
 * **我第一版的修法是错的** —— 我把两个口径并排显示 + 解释差额来源：
 * ```
 *   本段变化  +$8.58 USDT (+8.57%)  本机器人归属
 *   同期账户  −$2.10 USDT (−2.09%)  同一钱包含其他机器人（…多 +$10.67）
 * ```
 *
 * **第二次反馈（原话）**：
 * > 「图标完全乱套了，上面叫归属权益、同期账户、本段变化，一大堆莫名其妙的，
 * >  搞这么多没用的画蛇添足，无端增加BUG？图标不就是最真实准确简单的，
 * >  **账号余额、总盈亏能对上的吗**？」
 *
 * **他是对的。** 那个修法把"数字对不上"换成了"要读两行解释才懂" ——
 * 而问题有更简单的解：**让曲线画账户口径**。
 *
 * ## 定稿方案
 *
 * ```
 *   曲线 / 缩略条 / 「本段变化」  →  accountEquity（与「账户余额」同源）
 *   「交易盈亏」指标卡            →  仍走它的口径（那回答的是另一个问题）
 * ```
 * 于是屏幕上**只有一个权益数字**，不存在"对不上"这件事。
 *
 * ⚠️ 这个测试扫的是源码文本（注释里的同名字串会命中）——
 * 所以只断言"存在"，不断言"不存在"（见 `testUtils/sourceText.ts` 的教训）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PAGE = readFileSync(new URL('./TraderPage.tsx', import.meta.url), 'utf8');
const CHARTS = readFileSync(new URL('../components/DashboardCharts.tsx', import.meta.url), 'utf8');

test('★★★ 图表组件必须支持 `metric`，且默认是【账户口径】', () => {
  assert.ok(
    /metric\s*=\s*'account'/.test(CHARTS),
    '★ `DashboardEquityChart` 的 `metric` 默认值必须是 `account`（曲线要与指标卡对上）',
  );
  assert.ok(
    /snapshot\.accountEquity/.test(CHARTS),
    '★ 必须真的去读 `accountEquity`（不是只加了个参数）',
  );
});

test('★★★ 账户口径为 0 时必须回落到归属口径（否则曲线会砸到地板）', () => {
  /*
   * ⚠️ 迁移前的旧行 `account_equity` 是回填的，而**完全没有值时它是 `0`**
   *（见 `db/schema.ts` 的 M4 取舍说明）。直接用 0 会把曲线砸到地板，
   * 而那条曲线**看起来完全正常** —— 只是数字全错。
   */
  assert.ok(
    /accountEquity\s*>\s*0/.test(CHARTS),
    '★ 必须有 `accountEquity > 0` 的回落判据',
  );
});

test('★★★ 「本段变化」必须与曲线同口径（按模式选）', () => {
  assert.ok(
    /windowFirst\s*=/.test(PAGE) && /windowAccountFirst/.test(PAGE),
    '★ `windowFirst` 必须优先取账户口径',
  );
  assert.ok(
    /windowLast\s*=/.test(PAGE),
    '★ 必须有 `windowLast`（末端用实时账户权益，与指标卡严格相等）',
  );
  assert.ok(
    /liveAccountEquityForCurve/.test(PAGE),
    '★ 末端必须优先用实时账户权益（与「账户余额」同源）',
  );
  /*
   * ⚠️ 2026-10-15：首末端都要**跟着 `curveMetric` 走** —— 否则模拟盘上
   * "本段变化"算的是账户口径（恒 0），而线画的是归属口径（在变），两者对不上。
   */
  assert.ok(
    /curveMetric === 'attributed'/.test(PAGE),
    '★ 首末端必须按 `curveMetric` 分支（模拟盘走归属口径）',
  );
});

test('★★★ 缩略条必须与展开态【同一个口径】（2026-10-15 改成按模式选）', () => {
  /*
   * ## 原来这条钉的是"一律账户口径"
   *
   * 2026-10-13 用户要求曲线与「账户余额」指标卡对上，所以统一走 `accountEquity`。
   * 那对**实盘**是对的。
   *
   * ## 但模拟盘上它必然是一条平线（用户实测报过）
   *
   * `#11`（模拟盘）的成交是本地模拟的、**从不触碰真实钱包**：
   * ```
   *   45 条快照：equity（归属）23 种值 · account_equity（账户）【1 种值】
   * ```
   * 所以口径必须按模式选，而**收起态与展开态必须选同一个** ——
   * 否则同一个东西在两种视图下画的是两条不同的线。
   */
  assert.ok(
    /curveMetric === 'attributed'/.test(PAGE),
    '★ 缩略条必须按 `curveMetric` 取口径',
  );
  assert.ok(
    /const curveMetric: 'account' \| 'attributed' = isDryRun \? 'attributed' : 'account'/.test(PAGE),
    '★ 口径的选择规则：模拟盘 → 归属，实盘 → 账户',
  );
  /*
   * ⚠️ 展开态那个组件也要收到同一个 `metric`（不能写死 `"account"`）。
   */
  assert.ok(
    /metric=\{curveMetric\}/.test(PAGE),
    '★ `DashboardEquityChart` 必须收到 `metric={curveMetric}`（不能写死）',
  );
});

test('★★★ 那一行必须只有【一行】（对照行已按用户要求删除）', () => {
  /*
   * ⚠️ 用户的原话是「一大堆莫名其妙的，搞这么多没用的画蛇添足」。
   * 所以这里钉住"那一行的渲染里只有一个 flex 容器" ——
   * 如果谁再加回第二行解释，这条会红，而人会回来看这段注释。
   */
  const i = PAGE.indexOf('function EquityWindowLine');
  assert.ok(i >= 0, '★ 找不到 `EquityWindowLine`');
  const body = PAGE.slice(i, i + 2600);
  const divCount = (body.match(/<div className="mb-2/g) ?? []).length;
  assert.equal(divCount, 1, `★ 那一行只能有一个容器（实际 ${divCount} 个）`);
  assert.ok(
    !/account:\s*\{/.test(body),
    '★ 不该再有 `account` 这个 prop（对照行已删除）',
  );
});
