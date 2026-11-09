/**
 * **信号健康度必须真的接线** —— 防它退回"只有测试引用"的死代码。
 *
 * ## 为什么这个测试存在（2026-11-09 审计）
 *
 * `signalHealth.assessSignal()` 与 `attribution` 的两个辅助函数曾经在**生产代码里
 * 零调用**，只有测试引用 —— 失效检测永远 `insufficient_data`，而测试全绿。
 *
 * 这与 `configWiringGuard.test.ts` 封的是同一族缺口（"写了但没接线"）：
 * 代码存在、类型正确、测试通过，只是从来不会被执行。修完接线之后，**必须有一条
 * 守卫盯着它**，否则下一次重构（这个文件是仓库里最大的文件之一）随时可能把调用
 * 删掉而没人发现。
 *
 * ## 判据（与 `configWiringGuard` 同风格：纯文本扫描 + 前置断言 + 探针）
 *
 * ① `autoTrader.ts` 必须调用 `this.observeSignalHealth()`，且该方法内部必须调用
 *    `signalHealthReportFor()` —— 否则"周期复盘"只是个名字；
 * ② `signalHealthReport.ts` 必须真的调用 `assessSignal()` / `tradesForSignal()` /
 *    `signalsWithEnoughSamples()` —— 否则报告不会用任何判定逻辑；
 * ③ 全仓非测试源码里，这三个函数在**定义处之外**至少各有一个调用点。
 *
 * ## 边界
 *
 * 纯文本判据抓不住"调用被包在 `if (false)` 里"这种形态；它抓的是**删除调用**这一档，
 * 而那是最可能发生的。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SERVER_SRC = fileURLToPath(new URL('../../', import.meta.url));
assert.ok(
  existsSync(join(SERVER_SRC, 'trader', 'autoTrader.ts')),
  `找不到 server/src（解析到 ${SERVER_SRC}）—— 本测试无法工作`,
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const isDir = statSync(full).isDirectory();
    if (isDir) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const PRODUCTION_FILES = walk(SERVER_SRC);

/** 某个标识符在全部**非测试**源码里出现的次数。 */
function countInProduction(needle: RegExp): number {
  let total = 0;
  for (const file of PRODUCTION_FILES) {
    const matches = readFileSync(file, 'utf8').match(needle);
    if (matches) total += matches.length;
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/*  ① 周期里真的调用了复盘                                                       */
/* -------------------------------------------------------------------------- */

test('★★★ `AutoTrader` 的周期必须调用 `observeSignalHealth()`，且它真的生成报告', () => {
  const source = readFileSync(join(SERVER_SRC, 'trader', 'autoTrader.ts'), 'utf8');

  assert.ok(
    /this\.observeSignalHealth\(\)/.test(source),
    '★★★ `autoTrader.ts` 里没有 `this.observeSignalHealth()` 调用 —— ' +
      '信号健康度会退回"只有测试引用"的死代码',
  );
  assert.ok(
    /private observeSignalHealth\(\): void/.test(source),
    '★★★ 找不到 `observeSignalHealth()` 的定义',
  );
  assert.ok(
    /signalHealthReportFor\(/.test(source),
    '★★★ `observeSignalHealth()` 必须调用 `signalHealthReportFor()` 生成报告',
  );
});

/* -------------------------------------------------------------------------- */
/*  ② 报告模块真的用了判定逻辑                                                   */
/* -------------------------------------------------------------------------- */

test('★★★ `signalHealthReport.ts` 必须调用 assessSignal / tradesForSignal / signalsWithEnoughSamples', () => {
  const source = readFileSync(
    join(SERVER_SRC, 'trader', 'intel', 'signalHealthReport.ts'),
    'utf8',
  );
  for (const fn of ['assessSignal(', 'tradesForSignal(', 'signalsWithEnoughSamples(']) {
    assert.ok(
      source.includes(fn),
      `★★★ \`signalHealthReport.ts\` 没有调用 \`${fn}\` —— 报告会变成"读了数据但不判定"`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  ③ 全仓生产源码里的调用点（不只定义处）                                        */
/* -------------------------------------------------------------------------- */

test('★★★ 三个判定函数在生产源码里必须有定义处之外的调用点', () => {
  for (const fn of ['assessSignal', 'tradesForSignal', 'signalsWithEnoughSamples']) {
    /* 定义 1 次 + 调用 ≥1 次。 */
    const count = countInProduction(new RegExp(`\\b${fn}\\b`, 'g'));
    assert.ok(
      count >= 2,
      `★★★ \`${fn}\` 在 ${PRODUCTION_FILES.length} 个生产源码文件里只出现 ${count} 次 —— ` +
        '它很可能又变回了"只有定义、没有调用"（失效检测会永远 insufficient_data）',
    );
  }

  /* `intel_keys` 的读取侧也必须在生产代码里被调用（仓储定义之外）。 */
  const readers = countInProduction(/\bintelAttributionsSince\(/g);
  assert.ok(
    readers >= 2,
    `★★★ \`intelAttributionsSince(\` 在非测试源码里只出现 ${readers} 次 —— ` +
      '`trades.intel_keys` 又会变成只写不读',
  );
});

/* -------------------------------------------------------------------------- */
/*  探针校准：判据不是空转                                                        */
/* -------------------------------------------------------------------------- */

test('★★ 判据能报出"零调用"的标识符 —— 用不存在的名字证明扫描有效', () => {
  const fake = 'definitelyNotCalledAnywhereInProduction';
  assert.equal(countInProduction(new RegExp(`\\b${fake}\\b`, 'g')), 0);

  /* 同时证明它不会把真实存在的东西误判成 0。 */
  assert.ok(countInProduction(/\bassessSignal\b/g) > 0);
});
