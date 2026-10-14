/**
 * **空仓时也要盯候选池**（2026-10-14 · "持续工作"缺的那一半）
 *
 * ## 原来的结构性盲区
 *
 * `checkPositionMoves()` 原来在**没有持仓时直接 return**：
 * ```
 *   if (open.length === 0) { this.moveBaseline.clear(); return; }
 * ```
 * 理由"没持仓就没有持仓剧变可言"本身是对的，但它**默认了唯一值得唤醒的
 * 事就是"已有仓位的价格动了"**。
 *
 * 而这个文件自己的注释（`detectSharpMove` 文件头）**早就点出了相反的例子**：
 * ```
 *   · 一个候选突破 —— 该考虑开仓，但没成交就不唤醒
 * ```
 * 于是：
 * ```
 *   空仓时（最该找机会的时候）→ 监控什么都不做
 *   → 只能等 15 分钟定时器 → 而"7×24 持续找机会"要求它别干等
 * ```
 *
 * ## 为什么改完【请求数反而变少】
 *
 * 实测：`GET /fapi/v1/premiumIndex` **不带 `symbol` 时一次返回全市场 930 个标的**
 * （`market.ts` 的注释也写着 "With no symbol, Binance returns the whole universe
 * in one weighted call"）。
 * ```
 *   改前：逐个持仓 getMarkPrice → N 次请求（N = 持仓数）
 *   改后：一次 premiumIndex()   → 1 次请求（覆盖持仓 + 候选池 + 全市场）
 * ```
 *
 * ## 两个阈值必须不同
 *
 * ```
 *   持仓 3%：「我这个仓位是不是要出事了」  → 该早看
 *   候选 5%：「市场里是不是出现了新机会」  → 值得打断节奏才看
 * ```
 * 用同一个会让空仓机器人被大量无关波动反复唤醒（每次都真花钱）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const AUTO = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
const CODE = codeOnly(AUTO);

/** 取出 `checkPositionMoves` 的函数体（剥注释后的代码）。 */
function checkBody(): string {
  const at = CODE.indexOf('private async checkPositionMoves');
  assert.ok(at > 0, '★ 应当能找到 checkPositionMoves');
  return CODE.slice(at, at + 6000);
}

test('★★★ 无持仓时不能直接 return（那正是"最该找机会"的时刻）', () => {
  const body = checkBody();
  /*
   * ⚠️ 判据：不该再有"open.length === 0 → 清空基准并 return"这个形状。
   */
  assert.ok(
    !/if \(open\.length === 0\) \{\s*\/\*[^*]*\*\/\s*this\.moveBaseline\.clear\(\);\s*return;\s*\}/.test(body),
    '★ 无持仓不能直接 return —— 那时该盯候选池，而不是什么都不做',
  );
  assert.ok(
    /candidateWatchSymbols\(\)/.test(body),
    '★ 必须把候选池纳入监控范围',
  );
});

test('★★★ 必须用【一次】premiumIndex 拿全市场（不是逐个 getMarkPrice）', () => {
  const body = checkBody();
  assert.ok(
    /this\.deps\.market\.premiumIndex\(\)/.test(body),
    '★ 必须一次调用拿全市场 —— 实测它返回 930 个标的（不带 symbol 时）',
  );
  assert.ok(
    !/getMarkPrice\(/.test(body),
    '★ 不该再逐个标的查（改前 N 次请求，改后 1 次；盯的标的还更多）',
  );
});

test('★★★ 读不到全市场价格时什么都不做（不能把基准清掉）', () => {
  const body = checkBody();
  /*
   * ⚠️ 用空价格表当成"价格没动"会把基准悄悄清掉，下一轮就永远触发不了。
   */
  assert.ok(
    /if \(universe\.length === 0\) return;/.test(body),
    '★ 行情读不到时直接返回 —— 下一轮会重试',
  );
});

test('★★★ 候选阈值必须与持仓阈值分开（且更高）', () => {
  assert.ok(
    /const CANDIDATE_MOVE_THRESHOLD_PERCENT = 5;/.test(CODE),
    '★ 候选阈值必须单独定义（默认 5%）',
  );
  assert.ok(
    /AQ_CANDIDATE_MOVE_PERCENT/.test(CODE),
    '★ 候选阈值要能被环境变量覆盖',
  );
  const body = checkBody();
  assert.ok(
    /heldMoves/.test(body) && /candidateMoves/.test(body),
    '★ 两类标的必须分开判定（它们要回答的问题不同）',
  );
});

test('★★ 离场标的的基准要清掉（否则下次持有它会误报剧变）', () => {
  const body = checkBody();
  assert.ok(
    /this\.moveBaseline\.delete\(symbol\)/.test(body),
    '★ 不再盯的标的必须清基准 —— 否则下次持有它时拿旧价比对',
  );
});

test('★★ 候选池来源要能兜底（刚启动时上一轮还是空的）', () => {
  assert.ok(
    /private candidateWatchSymbols\(\)/.test(CODE),
    '★ 必须有唯一实现',
  );
  assert.ok(
    /staticCoins/.test(CODE),
    '★ 刚启动时退回配置里的 staticCoins（否则那个窗口期无人盯）',
  );
  assert.ok(
    /lastCandidateSymbols/.test(CODE),
    '★ 复用上一轮算过的候选池（15 分钟内几乎不变，不必每 60 秒重算烧权重）',
  );
});
