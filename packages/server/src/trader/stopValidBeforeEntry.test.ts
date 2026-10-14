/**
 * **开仓前必须先确认止损还有效**（2026-10-15 线上实测抓到）
 *
 * ## 事故：同一形状的浪费重复了 4 次
 *
 * 线上 `#11` 的日志（2026-10-14）：
 * ```
 *   QUSDT     止损 0.048537  vs 标记价 0.04901806  → 错误一侧 → 立即平仓
 *   TRUTHUSDT 止损 0.022545  vs 标记价 0.02180561  → 错误一侧 → 立即平仓
 *   BTWUSDT   止损 2.55126   vs 标记价 2.55684229  → 错误一侧 → 立即平仓
 *   WALUSDT   止损 0.051833  vs 标记价 0.05188987  → 错误一侧 → 立即平仓
 * ```
 * 四笔全是 **`净 +0.0000`** —— 付了一次往返手续费，什么都没得到。
 *
 * ## 根因
 *
 * ```
 *   模型基于材料里的 current_price 算止损（那时是对的）
 *   → 决策 → 风控 → 执行 之间隔了几十秒到几分钟
 *   → 价格漂移 1.3–2.0%，而止损距离只 1.0%
 *   → 实际成交时止损已落在标记价的另一侧
 * ```
 *
 * ## 修法：把"发现无效"从「开了再平」提前到「根本不开」
 *
 * ⚠️ **判据一字不改** —— 用的就是执行层后面那一条：
 * ```
 *   isValidTrigger(止损, 'STOP_MARKET', 平仓方向, 标记价) === false
 * ```
 * 只改了**发现它的时机**：从"开仓之后"提前到"开仓之前"。
 *
 * ## 为什么这不违反 §4.2（不许放宽风控）
 *
 * ```
 *   ✗ 放宽：把止损挪到另一侧好让单子挂上   ← 仍然禁止（现有注释已论证）
 *   ✓ 收紧：发现论点已死，这一单【不开】   ← 本次做的，只减少风险
 * ```
 *
 * ⚠️ **它不引入任何新的阈值** —— 不因为"价格偏离了几个点"就拦，
 * 那会变成"用一个没被授权的滑点阈值去否决风控的裁决"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const AUTO = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
const CODE = codeOnly(AUTO);

/** 取 `executeOpen` 里"市价开仓之前"那一段。 */
function preMarketSection(): string {
  const at = CODE.indexOf('开仓前止损已失效');
  assert.ok(at > 0, '★ 应当能找到那段新增的检查');
  return CODE.slice(Math.max(0, at - 2500), at + 1200);
}

test('★★★ 市价开仓【之前】必须检查止损是否已失效', () => {
  const body = preMarketSection();
  assert.ok(
    /const markBefore = await this\.deps\.broker\.getMarkPrice\(symbol\)/.test(body),
    '★ 必须在下单前读一次标记价',
  );
  assert.ok(
    /!this\.deps\.registry\.isValidTrigger\(decision\.stopLoss, 'STOP_MARKET', exitSide, markBefore\)/.test(body),
    '★ 判据必须与执行层那条【一字不差】（同一个被判无效的形状）',
  );
});

test('★★★ 失效时必须【不开仓】，而不是开了再平', () => {
  const body = preMarketSection();
  assert.ok(
    /status: 'rejected'/.test(body),
    '★ 返回 rejected —— 这一单不开',
  );
  assert.ok(
    /本次不开仓/.test(body),
    '★ 文案要说清"没开"，而不是"开了又平"',
  );
  /*
   * ⚠️ 检查必须排在 `placeOrder` 之前 —— 否则它就没有意义。
   */
  const at = CODE.indexOf('开仓前止损已失效');
  const placeAt = CODE.indexOf('const placed = await this.deps.broker.placeOrder(', at);
  assert.ok(placeAt > at, '★ 检查必须在 placeOrder 之前');
});

test('★★★ 读不到标记价时必须放行（读不到事实不该让功能停下）', () => {
  const body = preMarketSection();
  assert.ok(
    /markBefore > 0 &&/.test(body),
    '★ `markBefore > 0` 的条件 —— 读不到就放行，交给后面原有的逻辑',
  );
});

test('★★★ 必须记录被拒的订单（§2.2 每张订单都要留痕）', () => {
  const body = preMarketSection();
  assert.ok(
    /this\.recordOrder\(/.test(body),
    '★ 被拦下的单也要进 orders 表（含被拒绝的订单）',
  );
  assert.ok(
    /error: detail/.test(body),
    '★ 理由要落库 —— 那是审查"为什么这单没开"的唯一依据',
  );
});

test('★★ 不能让"没止损"的单被这条拦住（那只由风控的 requireStopLoss 管）', () => {
  const body = preMarketSection();
  assert.ok(
    /if \(decision\.stopLoss && decision\.stopLoss > 0\)/.test(body),
    '★ 只在【有止损】时检查 —— 没止损是另一条规则（风控第 4 步）的事',
  );
});

test('★★ 只在市价路径检查（限价单成交在未来，此刻检查无意义）', () => {
  /*
   * ⚠️ 限价单走 `submitLimitEntry`，它在**下单后就返回**（不建仓），
   * 成交发生在未来某一刻，那时由 `settlePendingEntries` 补挂保护单。
   * 此刻用"当前标记价"判断止损有效性，对一个还没成交的单没有意义。
   */
  const at = CODE.indexOf('开仓前止损已失效');
  const limitAt = CODE.indexOf("if (decision.entryType === 'limit'");
  assert.ok(at > 0 && limitAt > 0, '★ 两处都该在');
  assert.ok(
    limitAt < at,
    '★ 检查必须排在那段限价分支【之后】（限价单已经 return 了，不该被它拦）',
  );
});
