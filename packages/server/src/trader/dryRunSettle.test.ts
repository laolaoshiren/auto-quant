/**
 * **模拟盘的陈旧委托必须能结清**（2026-10-14 线上实测抓到的死锁）
 *
 * ## 事故
 *
 * 模拟盘 `#11`（`dry_run=1`）的 **44 条**委托永远停在 `NEW` ——
 * 界面下面「当前委托 17」列着"已挂单（待对账）"，而上面「保证金占用 / 持仓」都是 0。
 * 用户报：「下面的挂单委托，和上面的对不上问题怎么还没修复？」
 *
 * ## 死锁的形状（三个事实凑成的）
 *
 * ```
 *   ① 模拟盘的委托【从未真的发到交易所】
 *   ② 但 getOpenOrders / getOpenAlgoOrders 【没有 dryRun 守卫】→ 真去查交易所
 *      → 交易所返回 0 条（当然没有）
 *   ③ 而 getAlgoOrder 【有】dryRun 守卫：`if (this.dryRun) return null`
 *      → finalStatusOf 拿到 null → "这一轮不下结论" → 静默跳过
 *   ⇒ settleStaleOrders 永远返回 0，那些行永远停在 NEW
 * ```
 * ⚠️ **两个方法对 dryRun 的处理不一致**正是这个死锁的成因 ——
 * 一个去查交易所，另一个拒绝查。而**在模拟盘里，交易所本来就不该是真相来源**。
 *
 * ## 修法
 *
 * ```
 *   模拟盘：本地 positions 表说这个标的还有没有仓位 —— 那就是全部真相
 *   实盘  ：照旧问交易所（那是唯一的真相来源）
 * ```
 * ⚠️ 判据仍然用 `activeProtectionIds`（当前生效的保护单不碰）。
 * ⚠️ 写 `CANCELED` 而不是 `FILLED`：那张单从未成交，写 FILLED 会编造一次成交。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const AUTO = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');

test('★★★ settleStaleOrders 必须有模拟盘分支（否则永远结清不了）', () => {
  const code = codeOnly(AUTO);
  const fnAt = code.indexOf('private async settleStaleOrders');
  assert.ok(fnAt > 0, '★ 应当能找到 settleStaleOrders');
  const body = code.slice(fnAt, fnAt + 4000);
  assert.ok(
    /if \(this\.isDryRun\) \{/.test(body),
    '★ 必须有模拟盘分支 —— 交易所不是模拟盘的真相来源',
  );
  assert.ok(
    /orderStore\.update\(row\.id, \{ status: 'CANCELED' \}\)/.test(body),
    "★ 模拟盘要写 CANCELED（那张单从未成交，写 FILLED 会编造成交）",
  );
});

test('★★★ 模拟盘分支必须排在"读交易所"之前（否则走不到）', () => {
  const code = codeOnly(AUTO);
  const fnAt = code.indexOf('private async settleStaleOrders');
  const body = code.slice(fnAt, fnAt + 4000);
  const dryAt = body.indexOf('if (this.isDryRun) {');
  const liveAt = body.indexOf('getOpenOrders(');
  assert.ok(dryAt > 0 && liveAt > 0, '★ 两处都该在函数里');
  assert.ok(
    dryAt < liveAt,
    '★ 模拟盘分支必须排在读交易所之前 —— 否则它会去查一个永远空的列表',
  );
});

test('★★★ 模拟盘分支必须尊重 activeProtectionIds（当前生效的保护单不碰）', () => {
  const code = codeOnly(AUTO);
  const fnAt = code.indexOf('private async settleStaleOrders');
  const body = code.slice(fnAt, fnAt + 4000);
  const dryBlock = body.slice(body.indexOf('if (this.isDryRun) {'), body.indexOf('const symbols = ['));
  assert.ok(
    /activeProtectionIds\.has\(/.test(dryBlock),
    '★ 模拟盘分支也必须跳过当前生效的保护单 —— 否则会把活着的保护单写成终态',
  );
});

test('★★★ 实盘路径不能被动到（它本来是对的）', () => {
  const code = codeOnly(AUTO);
  assert.ok(
    /getOpenAlgoOrders\(/.test(code) || /this\.deps\.broker\.getOpenAlgoOrders/.test(code),
    '★ 实盘仍必须问交易所要挂单列表',
  );
  assert.ok(
    /finalStatusOf\(/.test(code),
    '★ 实盘仍必须用 finalStatusOf 定终态',
  );
});

test('★★ getAlgoOrder 的 dryRun 守卫必须保留（那是它对模拟盘的既有约定）', () => {
  const BROKER = readFileSync(new URL('../binance/broker.ts', import.meta.url), 'utf8');
  /*
   * ⚠️ 不要为了"修死锁"就把 `if (this.dryRun) return null` 删掉 ——
   * 那会让模拟盘去查一个不存在的单号。修法应该在**调用方**（settleStaleOrders）。
   */
  assert.ok(
    /async getAlgoOrder[\s\S]{0,200}?if \(this\.dryRun\) return null/.test(codeOnly(BROKER)),
    '★ getAlgoOrder 的 dryRun 守卫要保留 —— 修法在调用方，不在它这里',
  );
});
