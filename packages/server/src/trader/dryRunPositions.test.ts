/**
 * **模拟盘的持仓必须能活过一轮**（2026-10-15 线上实测抓到的核心功能缺陷）
 *
 * ## 事故：团队模式的仓位平均只活 3.8 分钟
 *
 * 用户开了团队模式机器人 `#11`（`dry_run=1`），实测它的 37 笔平仓：
 * ```
 *   持有时间：最短 0.0 分 · p50 3.8 分 · p90 6.2 分 · 最长 7.3 分
 *   【持有 > 15 分钟（超过一个周期）的：0 笔】
 *
 *   对照 #10（实盘，同一个平台）：p50 109 分 · 94% 超过 15 分钟
 * ```
 * 也就是说：**它开仓，然后在同一个周期里被自己对账平掉，再开仓，如此空转。**
 * 那正是"团队模式为什么不赚钱"的真正答案 —— 不是模型不行，是**仓位活不过一轮**。
 *
 * ## 根因（三个事实凑成的）
 *
 * ```
 *   ① 模拟盘的成交是本地模拟的（`simulateStandard`）—— 从不真的下单
 *   ② 而 `BinanceBroker.getPositions()` 【没有 dryRun 守卫】→ 真去查交易所
 *      → 那个账户上从来没有它的仓位 → 恒返回空数组
 *   ③ `reconcilePositions()` 于是看到"本地有、交易所没有"
 *      → `bookVanishedPosition()` 拿 `lastFillFor()`（可能是同账户【其他机器人】
 *        的成交价）当出场价 → `detectCloseReason()` 猜一个原因
 *      → `positionStore.close()` 把仓位抹掉
 * ```
 *
 * ## 次生伤害（同一份数据实测）
 *
 * ```
 *   · 保护单从未成交：stop_loss / take_profit 的 FILLED = 0（31 张 CANCELED）
 *   · 31/32 笔的出场价【离所有保护单都 >0.5%】（最远 5.74%）
 *     ⇒ close_reason 是"离谁近猜谁"，而那个"最近的"不是触发它的单
 *   · 标 take_profit 却亏钱 5 笔（止盈单在有利方向，逻辑上不可能）
 * ```
 *
 * ## 修法
 *
 * `effectivePositions()`：**模拟盘用本地持仓 + 真实标记价合成**，
 * 实盘直接转发。一处生效、处处生效 —— 而"处处"包括：
 * ```
 *   reconcilePositions    ← 不再把每个仓位判成"已消失"
 *   applyDrawdownGuard    ← 回撤守卫从"从不触发"变成真的会触发
 *   applyBreakevenGuard   ← 保本/移动止损从"从不触发"变成真的会触发
 *   recordEquity          ← 浮盈不再恒为 0（权益曲线因此才有形状）
 * ```
 *
 * ⚠️ **实盘一行都不动** —— 那里交易所就是唯一真相来源，而 `#10 赚大钱`
 * 正在用真实资金跑（用户的硬约束）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const AUTO = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
const CODE = codeOnly(AUTO);

test('★★★ 必须有 effectivePositions()，且模拟盘走本地持仓', () => {
  assert.ok(
    /private async effectivePositions\(symbol\?: string\): Promise<ExchangePosition\[\]>/.test(CODE),
    '★ 必须有 effectivePositions() —— 它是"按模式选持仓真相来源"的唯一入口',
  );
  const at = CODE.indexOf('private async effectivePositions');
  const body = CODE.slice(at, at + 1600);
  assert.ok(
    /if \(!this\.isDryRun\) return this\.deps\.broker\.getPositions\(symbol\);/.test(body),
    '★ 实盘必须直接转发（交易所是唯一真相来源）',
  );
  assert.ok(
    /positionStore\s*\r?\n?\s*\.open\(this\.deps\.trader\.id\)/.test(body) ||
      /positionStore\.open\(this\.deps\.trader\.id\)/.test(body),
    '★ 模拟盘必须用本地持仓合成（那些仓位本来就是本地模拟的）',
  );
  assert.ok(
    /getMarkPrice\(local\.symbol\)/.test(body),
    '★ 必须取真实标记价 —— 行情不是模拟的，浮盈要按它算',
  );
});

test('★★★ 对账不能用交易所持仓判模拟盘的仓位"已消失"', () => {
  /*
   * 这是那个缺陷的**直接成因**：`reconcilePositions` 拿交易所列表比对，
   * 而模拟盘上那个列表恒为空 → 每个本地仓位都被判成"已消失"并平掉。
   */
  const at = CODE.indexOf('private async reconcilePositions');
  assert.ok(at > 0, '★ 应当能找到 reconcilePositions');
  const body = CODE.slice(at, at + 2600);
  assert.ok(
    /if \(this\.isDryRun\) \{\s*\r?\n\s*await this\.settleDryRunPositions\(\);\s*\r?\n\s*return;/.test(body),
    '★ 模拟盘必须走自己的结算并 return —— 不能落到"比对交易所列表"那段',
  );
});

test('★★★ 模拟盘的保护单必须真的会触发（不能永远停在 NEW）', () => {
  assert.ok(
    /private async settleDryRunPositions\(\)/.test(CODE),
    '★ 必须有模拟盘结算 —— 否则保护单永不触发，close_reason 只能靠猜',
  );
  const at = CODE.indexOf('private async settleDryRunPositions');
  const body = CODE.slice(at, at + 3200);
  assert.ok(
    /const hitStop = stop !== null && stop > 0 && \(isLong \? mark <= stop : mark >= stop\)/.test(body),
    '★ 做多的止损判据是"标记价 ≤ 止损"（做空反过来）',
  );
  assert.ok(
    /const hitTarget =\s*\r?\n?\s*target !== null && target > 0 && \(isLong \? mark >= target : mark <= target\)/.test(
      body,
    ) || /target !== null && target > 0 && \(isLong \? mark >= target : mark <= target\)/.test(body),
    '★ 止盈判据同理',
  );
  assert.ok(
    /const exitPrice = hitStop \? \(stop as number\) : \(target as number\)/.test(body),
    '★ 成交价必须是【触发价】而不是标记价 —— 否则"止损距离"的归因会被污染',
  );
  assert.ok(
    /await this\.bookClosedPosition\(local, reason, exitPrice, exitFee\)/.test(body),
    '★ 必须走唯一的平仓记账路径（§2.3），不能自己写 trades',
  );
});

test('★★★ 止损优先：同一轮同时穿过止损与止盈时按保守方向处理', () => {
  const at = CODE.indexOf('private async settleDryRunPositions');
  const body = CODE.slice(at, at + 3200);
  assert.ok(
    /const reason: CloseReason = hitStop \? 'stop_loss' : 'take_profit'/.test(body),
    '★ 两个都碰到时按止损处理（少赚好过多亏）',
  );
});

test('★★★ 模拟盘的结算必须记手续费（记 0 会让它比现实更容易赚）', () => {
  const at = CODE.indexOf('private async settleDryRunPositions');
  const body = CODE.slice(at, at + 3200);
  assert.ok(
    /fallbackRoundTripFeeRate/.test(body),
    '★ 必须复用策略里已有的回退费率，而不是自己编一个',
  );
  assert.ok(
    /const exitFee = notional \* this\.activeConfig\.riskControl\.fallbackRoundTripFeeRate/.test(body),
    '★ 手续费 = 名义价值 × 往返费率',
  );
});

test('★★★ 回撤守卫与保本守卫也必须走 effectivePositions（否则模拟盘上静默失效）', () => {
  /*
   * ⚠️ 这两个是**静默失效**的典型：直接读 `broker.getPositions()` 在模拟盘上
   * 恒返回空 → 两个守卫**从不触发**，而界面上看不出任何异常。
   */
  for (const fn of ['applyDrawdownGuard', 'applyBreakevenGuard']) {
    const at = CODE.indexOf(`private async ${fn}`);
    assert.ok(at > 0, `★ 应当能找到 ${fn}`);
    const body = CODE.slice(at, at + 900);
    assert.ok(
      /await this\.effectivePositions\(\)/.test(body),
      `★ ${fn} 必须走 effectivePositions —— 否则模拟盘上它从不触发（静默失效）`,
    );
  }
});

test('★★ 读不到标记价时跳过结算，不猜', () => {
  /*
   * §2.3：读不到 ≠ 没触发。据一个猜出来的价平仓会**永久污染账本**。
   */
  const at = CODE.indexOf('private async settleDryRunPositions');
  const body = CODE.slice(at, at + 3200);
  assert.ok(
    /continue;/.test(body),
    '★ 标记价读不到时必须跳过这个标的（而不是用 0 或入场价硬算）',
  );
});
