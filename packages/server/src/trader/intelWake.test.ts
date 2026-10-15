/**
 * **情报触发的提前唤醒**（2026-10-14 · 去轮次化阶段 2）
 *
 * ## 用户对"去轮次"的终态定义（原话）
 *
 * > 「要完全脱离轮次这个概念（起码整体是脱离的，只有内部几个干定时工作的
 * >  AI 智能体才需要用到轮次，其他都是不间断在干活的）」
 *
 * ## 现状与缺口
 *
 * 唤醒源原本只有两个：成交 / 持仓剧变。而调研层虽已是独立 worker
 * （20 分钟自己的节奏），它查到强情报时**决策循环并不知道** ——
 * 要等下一个定时心跳。情报是缺的第三个唤醒源。
 *
 * ## 三道判据（每一道都防一类误唤醒）
 *
 * ```
 *   direction 是 bullish/bearish   ← neutral 不是信号
 *   confirmed（≥2 独立来源）        ← 单源传闻不值得打断
 *   freshness 是 fresh              ← 偏旧的不值得
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const MGR = codeOnly(readFileSync(new URL('./manager.ts', import.meta.url), 'utf8'));

test('★★★ 调研发现强情报时必须调 requestEarlyCycle', () => {
  assert.ok(
    /this\.running\.get\(traderId\)\?\.requestEarlyCycle\(why\)/.test(MGR),
    '★ 调研完成后，发现值得唤醒的情报必须叫醒决策循环（去轮次化的第三个唤醒源）',
  );
});

test('★★★ 三道判据缺一不可（neutral/未确认/偏旧都不该唤醒）', () => {
  for (const cond of [
    /r\.intel\.direction === 'bullish' \|\| r\.intel\.direction === 'bearish'/,
    /r\.assessment\.confirmed/,
    /r\.assessment\.freshness === 'fresh'/,
  ]) {
    assert.ok(cond.test(MGR), `★ 判据缺失：${String(cond)} —— 少一道都会让"不是信号的情报"打断决策`);
  }
});

test('★ 唤醒的理由必须进审计日志（操作员要能看到"为什么醒了"）', () => {
  assert.ok(
    /情报唤醒：/.test(MGR) && /runtimeLogs\.write\(traderId, 'info', 'team'/.test(MGR),
    '★ 唤醒必须留痕 —— 否则"决策为什么提前发生"查不到原因',
  );
});

test('★ 现有的两个唤醒源不能被弄丢（成交/持仓剧变）', () => {
  /*
   * 情报是【新增】的第三个源，不是替换。
   *
   * ⚠️ **这条原来查的是 `manager.ts` 里的一句注释**（`/持仓剧变/.test(rawMgr)`），
   * 而"持仓剧变"的**真正实现**在 `autoTrader.ts:1623`
   *（`this.requestEarlyCycle(\`${heldReason !== null ? '持仓剧变' : '候选异动'}：…\`)`）。
   *
   * 后果：2026-10-16 我删掉 `manager.ts` 里一段**不可达代码**时，
   * 这条断言跟着变红 —— 而**功能一点没坏**。**判据找错了文件**。
   *
   * ⚠️ 这与本仓库反复出现的形态同族：**判据看起来在守 A，实际守的是 A 的提及**。
   * 注释可以随便改，实现才是要守的东西。
   */
  const rawMgr = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');
  assert.ok(
    rawMgr.includes("requestEarlyCycle('有成交')"),
    '★ 成交唤醒还在（`manager.ts` 的成交即时对账里）',
  );

  /* ⚠️ 持仓剧变查**实现文件**，不查注释。 */
  const rawTrader = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
  assert.ok(
    rawTrader.includes("'持仓剧变'") && /this\.requestEarlyCycle\(/.test(rawTrader),
    '★ 持仓剧变唤醒还在（`autoTrader.ts` 的持仓剧变监控里）——\n' +
      '    ⚠️ 它**不该**去 `manager.ts` 里找：那里只有注释提过它。',
  );
});
