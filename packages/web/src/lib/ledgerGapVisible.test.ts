/**
 * **账本差额必须出现在界面上**（2026-10-14 用户报"列表页和详情页数据对不上"）
 *
 * ## 事故
 *
 * 列表页「盈亏」显示 **+4.84**（本地记账），详情页「账户余额」显示 **92.34**
 * （交易所真实值），两者差 **12.55** —— 而界面上**没有任何地方解释这个差**。
 *
 * ## 根因：两个数字口径不同，而界面没说
 *
 * ```
 *   本地记账（trades 净额合计） = 起始 + 已实现净额 = 104.89  ← 列表页
 *   交易所真实权益              = 92.34                       ← 详情页
 *   差额（ledger_check.gap）    = 12.55                       ← 只在后端台账里
 * ```
 * 线上实测（`#10` 的 `ledger_check:10`）：
 * ```json
 *   { "platformNet": 4.840488, "exchangeNet": -7.712181, "gap": 12.552669,
 *     "foreignNet": 0, "foreignRounds": 0 }
 * ```
 * 系统**每轮都在检测它**，但那个数字只进了后端台账与给模型看的提示词 ——
 * 没有进任何界面。所以操作员看到两个数字对不上，而**无处可知为什么**。
 *
 * ## 修法（三处，缺一不可）
 *
 * ```
 *   ① API：`readForeignActivityFor` 补上 `ledgerGap`（它本来就该在这里，
 *      因为那个端点就是为"账户余额不对"建的）
 *   ② 前端类型：`api.foreignActivity` 的返回类型补上
 *   ③ 界面：`BalanceCells` 的 `gapNote` —— 与 `foreignNote` 并排
 * ```
 *
 * ⚠️ 阈值 0.01：小于一分钱的差是浮点噪声，报出来只会制造告警疲劳。
 * ⚠️ 措辞不替用户下结论（与 `foreignNote` 同一条原则）：系统能算出"差多少"，
 *    但分不清是对账重建缺陷还是本地漏记。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SERVER = readFileSync(new URL('../../../server/src/api/routes/traderDataRoutes.ts', import.meta.url), 'utf8');
const API = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const CELLS = readFileSync(new URL('../components/BalanceCells.tsx', import.meta.url), 'utf8');

test('★★★ 后端 API 必须返回 ledgerGap（它是"对不上"的量化答案）', () => {
  assert.ok(
    /ledgerGap\?: number/.test(SERVER),
    '★ readForeignActivityFor 的返回类型必须有 ledgerGap',
  );
  assert.ok(
    /ledger_check:\$\{traderId\}/.test(SERVER),
    '★ 必须读 ledger_check 台账（差额在那里）',
  );
  assert.ok(
    /incomeReadFailed/.test(SERVER),
    '★ ⚠️ 读流水失败那一轮的 gap 是【假差额】—— 必须排除（与 readForeignActivity 同一条判据）',
  );
});

test('★★★ 前端 API 类型必须同步（否则界面拿不到那个字段）', () => {
  assert.ok(/ledgerGap\?: number/.test(API), '★ api.foreignActivity 的返回类型必须有 ledgerGap');
});

test('★★★ 界面必须有 gapNote，且阈值是 0.01', () => {
  assert.ok(/const gapNote/.test(CELLS), '★ 必须有 gapNote');
  assert.ok(
    /Math\.abs\(foreign\.ledgerGap\) > 0\.01/.test(CELLS),
    '★ 阈值 0.01 —— 小于一分钱的差是浮点噪声，报出来只会制造告警疲劳',
  );
  assert.ok(/账目与交易所差/.test(CELLS), '★ 必须有一句人能看懂的说明');
});

test('★★★ gapNote 必须在【两个分支】都渲染（停止时才是最需要它的时候）', () => {
  /*
   * ⚠️ 这是本文件已经踩过一次的坑（见 `foreignNote` 的注释）：
   * 只加在"有实时读数"分支里 → 机器人停止时它一次都不显示。
   * 而"账户余额不对"正是停下来排查的场景。
   */
  const count = (CELLS.match(/\{gapNote\}/g) ?? []).length;
  assert.ok(count >= 2, `★ gapNote 必须渲染两次（有读数 / 无读数两个分支），实际 ${count} 次`);
});

test('★★★ 措辞不能替用户下结论（系统分不清原因）', () => {
  assert.ok(
    /分不清是哪一个原因/.test(CELLS),
    '★ 必须说清"系统只能算出差多少，不能断言是谁的错" —— 与 foreignNote 同一条原则',
  );
});
