/**
 * **"交易所说这张单不存在"必须能结清，不能死锁**
 *（2026-10-14 线上实测：42 条委托永远停在 `NEW`）
 *
 * ## 死锁的形状
 *
 * ```
 *   交易所真的查不到这张单（-2013 Order does not exist）
 *   → getAlgoOrder 把所有错误都变成 null
 *   → finalStatusOf 把 null 读成"这一轮不下结论" → return null
 *   → settleStaleOrders 的 `if (!outcome) continue` 静默跳过
 *   → 那些行【永远】停在 NEW
 * ```
 * 线上实测（`#11`）：**42 条**本地 `NEW` 条件单，逐个查都回
 * `{"code":-2013,"msg":"Order does not exist."}` —— 而界面一直显示"已挂单"。
 *
 * ## 为什么那个取舍本身是对的
 *
 * `null` = "读不到，不下结论" —— 网络抖动、鉴权失败时**绝不能**改账
 *（把一张可能还挂着的保护单写成终态 = 在自己造 §2.6 的事故）。
 *
 * ## 但它漏了一种情况：交易所**明确说**它不存在
 *
 * 那不是"读不到"，那是一个**可判定的答案** —— 那张单已经结束了。
 *
 * ## 修法
 *
 * ```
 *   -2013 / "Order does not exist" → 返回 'not-found' → 写 CANCELED
 *   其它错误（网络 / 鉴权 / 限流） → 仍然返回 null（什么都不写）
 * ```
 * ⚠️ 这两件事被混成一件正是这个 bug 的成因 —— 所以本文件钉住"必须区分"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const BROKER = readFileSync(new URL('../binance/broker.ts', import.meta.url), 'utf8');
const AUTO = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
const STALE = readFileSync(new URL('./staleOrders.ts', import.meta.url), 'utf8');
const RECONCILE = readFileSync(new URL('./positionReconcile.ts', import.meta.url), 'utf8');

test('★★★ getAlgoOrder 必须把"交易所说不存在"翻译成 not-found', () => {
  assert.ok(
    /Promise<BinanceAlgoOrderResponse \| null \| 'not-found'>/.test(BROKER),
    "★ 返回类型必须含 'not-found' —— 否则调用方无法区分",
  );
  /*
   * ⚠️ 判据用**错误码**（-2013），不用文案 —— 文案会随语言/版本变。
   */
  assert.ok(
    /\/-2013\\b\/\.test\(message\)/.test(BROKER),
    '★ 必须按错误码 -2013 判定（文案会变）',
  );
  assert.ok(
    /return 'not-found'/.test(BROKER),
    "★ 命中时要返回 'not-found'",
  );
});

test('★★★ finalStatusOf 必须把 not-found 写成终态（否则死锁）', () => {
  /*
   * ⚠️ **必须剥掉注释再判** —— 同时校验 autoTrader.ts 委托与 staleOrders.ts 实现。
   */
  const autoCode = codeOnly(AUTO);
  const autoFnAt = autoCode.indexOf('private async finalStatusOf');
  assert.ok(autoFnAt > 0, '★ autoTrader.ts 应当保留 finalStatusOf 委托入口');
  assert.ok(
    /resolveFinalOrderStatus\(/.test(autoCode.slice(autoFnAt, autoFnAt + 600)),
    '★ finalStatusOf 必须委托给 staleOrders.ts 的 resolveFinalOrderStatus',
  );

  const staleCode = codeOnly(STALE);
  const code = staleCode.slice(staleCode.indexOf('export async function resolveFinalOrderStatus'));
  const notFoundAt = code.indexOf("algo === 'not-found'");
  const nullAt = code.indexOf('if (!algo) return null');
  assert.ok(notFoundAt > 0, "★ 必须有 'not-found' 的分支 —— 否则那些行永远结清不了");
  assert.ok(nullAt > 0, '★ 仍然要保留"读不到就不下结论"那条');
  assert.ok(
    notFoundAt < nullAt,
    "★ 'not-found' 必须排在 `if (!algo) return null` 之前（否则永远走不到）",
  );
});

test('★★★ 安全边界不变：只有"交易所说不存在"才写终态', () => {
  const fn = STALE.slice(STALE.indexOf('export async function resolveFinalOrderStatus'));
  /*
   * ⚠️ 那一条必须是 `status: 'CANCELED'` 且**不带成交数字** ——
   * 我们分不清它是成交还是撤销，写成交数字就是编造。
   */
  const branch = /algo === 'not-found'\)\s*\{\s*return \{ status: 'CANCELED' \};/.exec(fn);
  assert.ok(branch !== null, "★ not-found 的分支必须只写 status: 'CANCELED'（不写 filledQty / avgPrice）");
});

test('★★ detectCloseReason 不能把 not-found 猜成止损或止盈', () => {
  /*
   * ⚠️ `'not-found'` 意味着"那张单结束了，但分不清是触发还是撤销"——
   * 拿它去猜平仓原因就是编造。它应该落空、继续走"用价位推断"的判据。
   */
  const autoCode = codeOnly(AUTO);
  const autoFnAt = autoCode.indexOf('private async detectCloseReason');
  assert.ok(autoFnAt > 0, '★ autoTrader.ts 应当保留 detectCloseReason 委托入口');
  assert.ok(
    /detectCloseReasonForPosition\(/.test(autoCode.slice(autoFnAt, autoFnAt + 800)),
    '★ detectCloseReason 必须委托给 positionReconcile.ts 的 detectCloseReasonForPosition',
  );
  assert.ok(
    /const statusOf = \(o: typeof stopOrder\)/.test(RECONCILE),
    '★ detectCloseReasonForPosition 必须先把状态抽出来（类型层面逼着处理 not-found）',
  );
  assert.ok(
    /o === null \|\| o === 'not-found' \? undefined : o\.algoStatus/.test(RECONCILE),
    "★ 'not-found' 必须映射成 undefined（落空），而不是映射成某个终态",
  );
});
