/**
 * **一页里所有盈亏数字必须用同一套口径**（2026-10-14 用户报"只做一半"）
 *
 * ## 事故
 *
 * 我上一轮只校准了「归属权益」那一格，而**同一行的「盈亏」列**、
 * **顶部的「已实现盈亏」汇总**仍用服务端的 `stats.*`（按**坏账本**算）：
 *
 * ```
 *   #10 归属权益 已校准（$93.16）· 盈亏 未校准（+5.65% 而真实 -6.99%）
 *   顶部「已实现盈亏」+5.91 而真实 -7.03
 * ```
 * 用户的原话：
 * > 「盈亏计算也不对啊！！！你做事情只做一半？？」
 *
 * ## 判据
 *
 * ```
 *   账本可信（|gap| < 0.01）→ 用服务端的 stats.*
 *   账本有差                → 用交易所的 ledger.exchangeNet
 * ```
 * 三处必须一致：**表格行（归属权益 / 盈亏 两列）+ 顶部汇总**。
 *
 * ⚠️ 汇总用 `calibratedOf` **逐机器人**求和的理由：
 * 直接对 `equityOf` 求和是错的（共享账户会把本金数多遍）；
 * 而净已实现盈亏**是可加的** —— 所以求和之后顶部与各行能对上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const PAGE = readFileSync(new URL('./TradersPage.tsx', import.meta.url), 'utf8');
const CODE = codeOnly(PAGE);

test('★★★ calibratedOf 必须从共享库的 realizedPnlOf 派生（不是本地判据）', () => {
  /*
   * ⚠️ 2026-10-14 重构：判据移到 `lib/fleetTotals.ts`（**一份实现**）。
   * 本页的 `calibratedOf` 现在只负责"把净额换算成百分比"，
   * **口径判断交给共享库** —— 否则又会变成"每个页面各写一遍"，
   * 而那正是用户报「你做事情只做一半？？」的成因。
   */
  assert.ok(
    /const calibratedOf = \(/.test(CODE),
    '★ 必须有 calibratedOf —— 否则每一列各算一套口径',
  );
  assert.ok(
    /const realizedPnl = realizedPnlOf\(trader, stats, dryRunOf\(trader\.id\)\);/.test(CODE),
    '★ 净额必须来自共享库的 realizedPnlOf（不是本地判据）—— 且要把 dryRun 一起传，' +
      '否则模拟盘上会拿到恒为 0 的 exchangeNet（2026-10-15 用户实测）',
  );
  assert.ok(
    /trader\.initialEquity > 0 \? \(realizedPnl \/ trader\.initialEquity\) \* 100 : 0/.test(CODE),
    '★ 收益率必须从【校准后的净额】算 —— 不能拿两套来源相减',
  );
});

test('★★★ 「盈亏」列必须用 calibratedOf（不能直接读 stats.totalReturnPercent）', () => {
  /*
   * ⚠️ 判据：渲染那两处不得出现裸的 `stats.totalReturnPercent` / `stats.realizedPnl`。
   */
  assert.ok(
    /pnlColor\(calibratedOf\(trader, stats\)\.returnPercent\)/.test(CODE),
    '★ 颜色必须按校准后的收益率判（否则红绿也是错的）',
  );
  assert.ok(
    /fmtPercent\(calibratedOf\(trader, stats\)\.returnPercent\)/.test(CODE),
    '★ 显示的百分比必须来自 calibratedOf',
  );
  assert.ok(
    /calibratedOf\(trader, stats\)\.realizedPnl/.test(CODE),
    '★ 下面那行「净 …」也必须来自 calibratedOf',
  );
  assert.ok(
    !/fmtPercent\(stats\.totalReturnPercent\)/.test(CODE),
    '★ 不能再直接显示 stats.totalReturnPercent',
  );
});

test('★★★ 顶部「已实现盈亏」必须逐机器人校准后求和', () => {
  assert.ok(
    /const totalRealized = traders\.reduce\(/.test(CODE),
    '★ 顶部汇总必须逐机器人算',
  );
  assert.ok(
    /calibratedOf\(trader, s\)\.realizedPnl/.test(CODE),
    '★ 汇总里必须用 calibratedOf（否则顶部与各行对不上）',
  );
  assert.ok(
    !/sum \+ \(statsMap\[trader\.id\]\?\.realizedPnl \?\? 0\)/.test(CODE),
    '★ 不能再用服务端的 realizedPnl 直接求和',
  );
});

test('★★★ 界面文案不能是内部行话（用户看不懂"账本/校准"）', () => {
  /*
   * ⚠️ 用户的原话：
   * > 「『账本有差 · 已按交易所校准』什么鬼意思？这是做给人看的？」
   *
   * ⚠️ **必须扫剥掉注释后的代码** —— 我在那段修复的说明里**引用了**旧文案
   * （"✗ 账本有差 · 已按交易所校准"），于是判据会命中注释、永远失败。
   * 这是本项目反复踩的同一个坑（判据必须只扫代码）。
   */
  assert.ok(
    !/账本有差 · 已按交易所校准/.test(CODE),
    '★ 不能用"账本"这类内部词 —— 那一行面对的是操作员',
  );
  assert.ok(
    /按交易所实际成交计/.test(CODE),
    '★ 应该说清"这个数从哪来"（人话）',
  );
  /*
   * ⚠️ 它是**口径说明**，不是告警 —— 用警示色会让操作员以为账目坏了
   *（而它恰恰是**更准**的那个数）。
   *
   * ⚠️ 窗口要够大：`className` 与那句文案之间隔着整个 `title`（约 400 字符）。
   * 我第一版只取 300 字符，于是判据永远失败 —— 而真因是窗口太小。
   */
  const at = CODE.indexOf('按交易所实际成交计');
  assert.ok(at > 0, '★ 应当能找到那句说明的渲染位置');
  const before = CODE.slice(Math.max(0, at - 800), at);
  assert.ok(
    before.includes('text-ink-faint'),
    '★ 口径说明要用安静的色（text-ink-faint），不用警示色',
  );
  assert.ok(
    !/text-warn(?![a-z-])/.test(before.slice(-600)),
    '★ 那段里不能用警示色 —— 它说的是"这个数从哪来"，不是"出问题了"',
  );
});
