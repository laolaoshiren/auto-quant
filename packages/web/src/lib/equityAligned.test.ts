/**
 * **权益口径必须只有一份实现**（2026-10-14 重构后）
 *
 * ## 这个文件的历史（很重要，不要把它改回去）
 *
 * ```
 *   第一版：判据散在【三个页面】里各写一遍
 *     · TradersPage    · OverviewPage    · TraderPage
 *     → 我在 2026-10-14 只修了其中两处，首页漏了
 *     → 用户报：「你做事情只做一半？？」
 *
 *   第二版（现在）：判据移到【共享库 fleetTotals.ts】，页面一律调它
 * ```
 * ⚠️ **所以本文件钉的不再是"三个页面各有一段相同代码"，而是
 * "三个页面都必须调用同一份实现"** —— 后者才是真正的保证：
 * 复制粘贴的相同代码会漂移，共享函数不会。
 *
 * ## 判据本身
 *
 * ```
 *   |ledger.gap| ≥ 0.01 且 incomeReadFailed 不为真 → 用交易所的 exchangeNet
 *   否则                                          → 用账本（它与交易所一致）
 * ```
 *
 * ⚠️ **`incomeReadFailed` 那道判据是这次补上的**：服务端读不到交易所收入流水时
 * 不返回 `exchangeNet`，那时它是**残缺读数** —— 拿它校准比坏账本更离谱。
 *（前端类型 `TraderRow.ledger` 原来也漏了这个字段，一并补上。）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnlyCss as codeOnly } from '../testUtils/cssText.js';

const SHARED = readFileSync(new URL('./fleetTotals.ts', import.meta.url), 'utf8');
const LIST = readFileSync(new URL('../pages/TradersPage.tsx', import.meta.url), 'utf8');
const OVERVIEW = readFileSync(new URL('../pages/OverviewPage.tsx', import.meta.url), 'utf8');
const DETAIL = readFileSync(new URL('../pages/TraderPage.tsx', import.meta.url), 'utf8');

test('★★★ 判据必须在共享库里只有一份实现', () => {
  const code = codeOnly(SHARED);
  assert.ok(
    /export function isLedgerSuspect\(/.test(code),
    '★ 必须导出 isLedgerSuspect —— 判据的唯一实现',
  );
  assert.ok(
    /Math\.abs\(ledger\.gap\) >= 0\.01/.test(code),
    '★ 阈值必须是 0.01（与详情页一字不差）',
  );
  /*
   * ⚠️ 这道判据是本次补的：读流水失败时 exchangeNet 是残缺读数，不能用来校准。
   */
  assert.ok(
    /if \(ledger\.incomeReadFailed === true\) return false;/.test(code),
    '★ incomeReadFailed 为真时必须判 false（残缺读数不能当真相）',
  );
});

test('★★★ 两个校准函数都在共享库里（权益 + 盈亏）', () => {
  const code = codeOnly(SHARED);
  assert.ok(
    /export function realizedPnlOf\(/.test(code),
    '★ realizedPnlOf 必须在共享库 —— 它是"盈亏"的唯一来源',
  );
  assert.ok(
    /export function attributedEquityOf\(/.test(code),
    '★ attributedEquityOf 必须在共享库 —— 它是"归属权益"的唯一来源',
  );
  assert.ok(
    /trader\.initialEquity \+ trader\.ledger!\.exchangeNet \+ row\.unrealizedPnl/.test(code),
    '★ 权益校准必须用 exchangeNet（账本里的 net_pnl 是坏的）',
  );
  assert.ok(
    /return trader\.ledger!\.exchangeNet;/.test(code),
    '★ 盈亏校准必须用 exchangeNet',
  );
});

test('★★★ 机器人列表页必须调用共享实现（不能再有本地副本）', () => {
  const code = codeOnly(LIST);
  assert.ok(
    /attributedEquityOf\(trader, stats, dryRunOf\(trader\.id\)\)/.test(code),
    '★ 归属权益必须调共享库（并把 dryRun 一起传下去 —— 模拟盘不能拿交易所校准）',
  );
  assert.ok(
    /realizedPnlOf\(trader, stats, dryRunOf\(trader\.id\)\)/.test(code),
    '★ 盈亏必须调共享库（同样要传 dryRun）',
  );
  /*
   * ⚠️ 本地副本必须消失 —— 那正是"只做一半"的成因（副本会漂移）。
   */
  assert.ok(
    !/const isLedgerSuspect = \(trader: TraderRow\): boolean =>/.test(code),
    '★ 不该再本地定义 isLedgerSuspect（它现在只有共享库那一份）',
  );
});

test('★★★ 首页总览必须调用共享实现（它原来是第三个副本）', () => {
  const code = codeOnly(OVERVIEW);
  assert.ok(
    /attributedEquityOf\(trader, statsMap\[trader\.id\], dryRunOf\(trader\.id\)\)/.test(code),
    '★ 首页必须调共享库（并传 dryRun）—— 它原来漏了 incomeReadFailed 那道判据',
  );
  /*
   * ⚠️ 用户报「图4 也是一样」—— 首页那张图的权益必须与列表页一致。
   */
  assert.ok(
    !/const suspect = trader\.ledger != null && Math\.abs\(trader\.ledger\.gap\) >= 0\.01/.test(code),
    '★ 首页不该再有本地判据副本',
  );
});

test('★★★ 详情页的判据必须来自共享库（它曾是唯一的本地副本）', () => {
  /*
   * ⚠️ 2026-10-15 改：这一页原来自己判 `Math.abs(ledger.gap) >= 0.01`，
   * 于是"模拟盘不校准"那条新判据只修了共享库、漏了这一页 ——
   * 而这一页正是用户报"卡片是 $0.00"的那一屏。
   *
   * 现在它必须调共享实现，并把 `dryRun` 传进去。
   */
  assert.ok(
    /const ledgerSuspect = isLedgerSuspect\(ledger, stats\?\.dryRun\)/.test(DETAIL),
    '★ 详情页必须调共享库的 isLedgerSuspect 并传 dryRun（不能再有本地副本）',
  );
  assert.ok(
    !/const ledgerSuspect = ledger !== null && Math\.abs\(ledger\.gap\) >= 0\.01/.test(DETAIL),
    '★ 那个本地副本必须消失 —— 它是「只做一半」的第四处形状',
  );
  /*
   * ⚠️ 判据本身仍是 0.01（在共享库里），这一条保证"改共享库的阈值"仍被钉住。
   */
  assert.ok(
    /Math\.abs\(ledger\.gap\) >= 0\.01/.test(codeOnly(SHARED)),
    '★ 阈值 0.01 必须在共享库里',
  );
  assert.ok(
    /const realized = ledgerSuspect \? ledger!\.exchangeNet : \(stats\?\.realizedPnl \?\? 0\)/.test(DETAIL),
    '★ 详情页仍必须用 exchangeNet（这是三处口径的基准）',
  );
});

test('★★★ 模拟盘绝不能拿 exchangeNet 校准（2026-10-15 用户实测）', () => {
  /*
   * ## 事故
   * 用户报 `#11`（模拟盘）的「交易盈亏」卡是 `$0.00`，而同页历史成交有
   * 25 笔、净额 −$0.58。根因：`SimulatedExchange.getIncome()` 返回空数组
   * → `exchangeNet = 0` → `gap = platformNet` 恒成立 → 判"账本可疑"
   * → 把**正确的账本**替换成 0。
   *
   * 所以判据里必须有 `dryRun === true → false` 这一条。
   */
  const code = codeOnly(SHARED);
  assert.ok(
    /if \(dryRun === true\) return false;/.test(code),
    '★ 模拟盘必须一律判 false —— 交易所口径在模拟盘上不存在',
  );
  assert.ok(
    /dryRun\?: boolean \| null,/.test(code),
    '★ isLedgerSuspect 必须接收 dryRun',
  );
  /*
   * ⚠️ 三个消费者都要把它传下去，否则判据在那一处失效。
   */
  assert.ok(
    /export function realizedPnlOf\(\s*trader: TraderRow,\s*row: TraderStats \| undefined,\s*dryRun\?: boolean \| null,/.test(code),
    '★ realizedPnlOf 必须接收 dryRun',
  );
  assert.ok(
    /export function attributedEquityOf\(\s*trader: TraderRow,\s*row: TraderStats \| undefined,\s*dryRun\?: boolean \| null,/.test(code),
    '★ attributedEquityOf 必须接收 dryRun',
  );
});

test('★★★ 列表页不能再并列显示两个互相矛盾的数', () => {
  /*
   * ⚠️ 用户的原话：「别画蛇添足」—— 原来那一格是
   * ```
   *   $104.89        ← 归属权益
   *   账户 $92.34    ← 账户（第二个数）
   * ```
   * 两个数并列而没有解释，用户第一反应是"到底哪个是我的钱"。
   */
  assert.ok(
    !/账户 \{fmtUsd\(stats\.accountEquity/.test(LIST),
    '★ 不该再并列显示「账户」那第二个数（那是用户说的"画蛇添足"）',
  );
});

test('★★ 整个 web 侧只有一处 0.01 判据（不允许再有别的容差副本）', () => {
  /*
   * ⚠️ 这条测试是本次重构的**守门人**：如果哪天有人又在某个页面里写了
   * `Math.abs(...ledger.gap) >= 0.01`，它就会失败并提醒"去调共享库"。
   *
   * ⚠️ `TraderPage`（详情页）是**已知的例外** —— 它有自己的 `ledgerSuspect`
   * 常量（那是本判据的**基准**，写在共享库之前）。它一并迁移属于后续工作，
   * 这里只要求它仍然是 0.01。
   */
  const copies: string[] = [];
  for (const [name, src] of [
    ['TradersPage', LIST],
    ['OverviewPage', OVERVIEW],
  ] as const) {
    const code = codeOnly(src);
    if (/Math\.abs\([^)]*ledger[^)]*\.gap\) >= 0\.01/.test(code)) copies.push(name);
  }
  assert.deepEqual(
    copies,
    [],
    `★ 这些页面里还有本地判据副本：${copies.join('、')} —— 应当调 isLedgerSuspect()`,
  );
});
