/**
 * **手续费必须按结算资产口径累加** —— 结构守卫。
 *
 * ## 为什么这个测试存在
 *
 * AGENTS §2.5 把口径写死了：`fee` 只允许 USDT/USDC 这类结算资产计价，
 * **非结算资产（BNB 抵扣）不计入 `fee`，要单独报告**。
 *
 * 而 `autoTrader.ts` 曾有 **6 处独立的** `sum + Number(fill.commission)`：
 *
 * ```
 *   feeForOrder · lastFillFor · entryFeeFor
 *   executeClose · executeReduce · emergencyFlatten
 * ```
 *
 * 六份副本全部忽略 `commissionAsset`。用户一旦开启币安的 BNB 手续费抵扣
 * （界面默认推荐），`commission` 就是 BNB 的**币数量**（约 1e-4），
 * 与 USDT 金额（约 1e-2）差三个数量级 —— 记进 `fee` 会让成本被低估约 570 倍，
 * `netPnl` 系统性偏乐观，而账目校验的差额告警会带着一段固定偏差永久响。
 *
 * 现在六处都走 `settlementFeeOf()` → `settlementCommissionOf()` 这一个实现。
 * 本测试盯着两件事，防止修复被下一次重构悄悄回退：
 *
 *   ① 代码里**不再出现**任何 `Number(<x>.commission)` 形式的直接累加；
 *   ② 六个调用点确实都经过共享实现，且非结算资产会被单独报告。
 *
 * ## 边界（诚实说明）
 *
 * · 它抓的是"文本模式"这一档：换成 `const c = fill['commission']` 之类可以绕过；
 * · 它不验证 `settlementCommissionOf` 的算术语义 —— 那由 `income.test.ts` 覆盖。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { codeOnly } from '../testUtils/sourceText.js';

const here = dirname(fileURLToPath(import.meta.url));
const autoTraderSrc = readFileSync(join(here, 'autoTrader.ts'), 'utf8');
const incomeSrc = readFileSync(join(here, '..', 'binance', 'income.ts'), 'utf8');
const autoTraderCode = codeOnly(autoTraderSrc);
const incomeCode = codeOnly(incomeSrc);

test('★ autoTrader 里不能再有裸的手续费累加（§2.5 的六份副本）', () => {
  /*
   * 判据：`Number(fill.commission)` / `Number(f.commission)` / … 这类直接读
   * `commission` 的写法，全部必须消失 —— 结算资产与否只有 helper 能判断。
   */
  const bare = /Number\([A-Za-z_$][\w$]*\.commission\)/g;
  const hits = [...autoTraderCode.matchAll(bare)].map((m) => m[0]);
  assert.deepEqual(
    hits,
    [],
    `发现裸的手续费累加：${hits.join('、')} —— 必须走 settlementCommissionOf()` +
      '（BNB 抵扣时 commission 是 BNB 数量，不是 USDT 金额）',
  );
});

test('★ 六个手续费调用点都经过共享实现', () => {
  /*
   * feeForOrder · lastFillFor · entryFeeFor · executeClose · executeReduce · emergencyFlatten
   * 六处都用 `this.settlementFeeOf(...)`。用 `>= 6` 而不是精确相等：
   * 将来多一条下单/平仓路径时，应该**再加一个调用**，而不是让守卫变红。
   */
  const calls = autoTraderCode.match(/this\.settlementFeeOf\(/g) ?? [];
  assert.ok(
    calls.length >= 6,
    `只找到 ${calls.length} 处 settlementFeeOf 调用，至少应有 6 处（六条手续费路径）`,
  );
  assert.ok(
    autoTraderCode.includes('private settlementFeeOf('),
    '共享实现 settlementFeeOf 不见了',
  );
});

test('★ 非结算资产手续费必须被单独报告，不能静默丢弃', () => {
  /* 运行时：每一笔带 foreign 的成交都要 emit 一条 warn。 */
  assert.ok(
    autoTraderCode.includes('private reportForeignFees('),
    '缺少 reportForeignFees —— 非结算资产手续费会被静默丢掉',
  );
  /* 对账重建：ReconstructedTrade.foreignFees 也要消费（原来没有任何消费方）。 */
  assert.ok(
    autoTraderCode.includes('this.reportForeignFees(trip.symbol, trip.foreignFees)'),
    '对账重建出来的 foreignFees 没有被报告 —— 它会凭空消失',
  );
});

test('★ income 流水口径同样只认结算资产', () => {
  /* 对账侧（commissionsInWindow）与总账校验（exchangeNet）都按 asset 过滤。 */
  const guards = incomeCode.match(/isSettlementAsset\(event\.asset\)/g) ?? [];
  assert.ok(guards.length >= 1, 'commissionsInWindow 缺少 asset 过滤');
  const ledgerGuards = autoTraderCode.match(/isSettlementAsset\(e\.asset\)/g) ?? [];
  assert.ok(
    ledgerGuards.length >= 1,
    '总账校验的 exchangeNet 缺少 asset 过滤 —— 两边口径不同会让差额告警永久响',
  );
});
