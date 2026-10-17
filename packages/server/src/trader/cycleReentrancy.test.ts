/**
 * **同一台机器人不许同时跑两轮**（执行侧的防重入）—— 这条不变量此前**零守卫**。
 *
 * ## 为什么需要它（这不是"代码风格"问题）
 *
 * 两条轮次同时在跑时，两轮会各自读到同一份持仓快照、各自算出开仓/平仓决策，
 * 然后**各自下单**：
 * ```
 *   两轮都认为"当前空仓" → 各开一次仓 → 仓位翻倍（而风控只看单轮的名义价值）
 *   两轮都认为"该平掉"   → 各发一次平仓 → 第二次变成反向开仓
 * ```
 * 也就是说：**重入会绕过风控的"单轮视角"** —— 风控引擎的每一次审查
 * （`packages/server/src/risk/engine.ts`，通往订单的唯一路径）都是**按轮**做的，
 * 而重入让同一时刻存在两份"单轮视角"。
 *
 * ## 四道闸门（本守卫逐一钉住）
 *
 * | 闸门 | 位置 | 若失效会怎样 |
 * | --- | --- | --- |
 * | `start()` 的幂等检查 | `autoTrader.ts` 的 `start()` | 连点两次"启动"→ 两次 `tick()` → 两条轮次并行 |
 * | `tick()` 的 `!running` 早退 | `tick()` 首行 | `stop()` 之后仍在排下一轮 |
 * | `tick()` 的 `cycleInFlight` 早退 | `tick()` 三行内 | 上一轮没跑完就开下一轮（这条是**唯一的**轮次互斥）|
 * | `inCycle()` 的唯一置真 + `finally` 复位 | `inCycle()` | 两处置真 → 早退判据失效；复位漏了 → 第一轮之后再不开新轮 |
 *
 * ⚠️ 判据里最容易被写错的一条是**"早退必须不排下一次"**：
 * `tick()` 的重入早退如果顺手排了下一轮，等于把"跳过"变成"推迟"，
 * 而两个 tick 会互相追着重排 —— 那是**排期风暴**的形状。
 *
 * ## 它抓不到什么（诚实说明）
 *
 * · **运行时才会暴露的重入**：例如某个 `await` 内部又调了一次 `start()`、
 *   或者外部为同一个 trader 建了**两个** `AutoTrader` 实例 —— 静态扫描看不见；
 * · **`start()` 里第一个 `await` 之前还有别的异步陷阱**（例如同步回调里再启动）；
 * · **`scheduleNextCycle` 内部的实现**（它自己是否清掉旧定时器）—— 那是另一件事；
 * · **多进程/多实例**：两个服务进程各跑同一个 trader，本守卫无从判断。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const RAW = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');

/** 剥注释但**保留行号**（报错里的行号就是文件行号）。 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

interface Member {
  name: string;
  startLine: number;
  endLine: number;
  body: string;
}

/*
 * ⚠️ 这套方法与 `closeBookingLedger.test.ts` 里的同名实现是**逐字一致的拷贝**。
 * 之所以不抽到 `testUtils/`：本任务的写作用域只有 `packages/server/src/trader/`
 * （见任务卡的 in scope），而 `testUtils/sourceText.ts` 在它之外。
 * 将来若允许动那个目录，应当把 `methodsOf` 收进 `sourceText.ts` 一份。
 */
function methodsOf(code: string): Member[] {
  const lines = code.split('\n');
  const out: Member[] = [];
  const isMember = (line: string): boolean =>
    /^ {2}(?:private |public |protected |static |async |readonly )*[a-zA-Z_$][\w$]*\s*[(<]/.test(line);
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([a-zA-Z_$][\w$]*)\s*[(<]/.exec(
      lines[i] ?? '',
    );
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isMember(lines[j] ?? '') || /^\}/.test(lines[j] ?? '')) {
        end = j;
        break;
      }
    }
    out.push({ name: m[1]!, startLine: i + 1, endLine: end, body: lines.slice(i, end).join('\n') });
  }
  return out;
}

/** 从 `{` 处配平取出一整个块（含首尾花括号）。取不到返回 `null`。 */
function braceBlock(text: string, braceIndex: number): string | null {
  if (text[braceIndex] !== '{') return null;
  let depth = 0;
  for (let i = braceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceIndex, i + 1);
    }
  }
  return null;
}

function countOf(text: string, needle: string): number {
  let n = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/*  判据（纯函数，可被人造源码校准）                                            */
/* -------------------------------------------------------------------------- */

/** 跑一遍全部防重入判据，返回问题清单。 */
function reentrancyProblems(code: string): string[] {
  const all = methodsOf(code);
  const byName = new Map(all.map((m) => [m.name, m]));
  const problems: string[] = [];

  const start = byName.get('start');
  if (start === undefined) {
    problems.push('找不到 start() —— 结构变了，请更新本守卫');
  } else {
    const firstAwait = start.body.indexOf('await ');
    const guardAt = start.body.indexOf('if (this.running) return;');
    const setAt = start.body.indexOf('this.running = true;');
    if (guardAt < 0) {
      problems.push(
        `第 ${start.startLine} 行：start() 里没有 \`if (this.running) return;\` —— ` +
          '连点两次启动会排两次 tick，两条轮次并行（各自下单、各自过风控）。',
      );
    } else if (firstAwait >= 0 && guardAt > firstAwait) {
      problems.push(
        `第 ${start.startLine} 行：start() 的重入检查排在**第一个 await 之后** —— ` +
          'await 让出执行权之后，第二次 start() 会通过检查（幂等性失效）。',
      );
    }
    if (setAt < 0) {
      problems.push(`第 ${start.startLine} 行：start() 没有置 \`this.running = true\``);
    } else if (firstAwait >= 0 && setAt > firstAwait) {
      problems.push(
        `第 ${start.startLine} 行：start() 置 running 排在**第一个 await 之后** —— ` +
          '两个并发 start() 会双双通过重入检查。',
      );
    }
  }

  const stop = byName.get('stop');
  if (stop === undefined || !stop.body.includes('this.running = false')) {
    problems.push('stop() 里没有 `this.running = false` —— 停了之后 tick 仍会继续跑');
  }

  const inCycle = byName.get('inCycle');
  if (inCycle === undefined) {
    problems.push('找不到 inCycle() —— 轮次互斥锁的家不见了');
  } else {
    const setTrue = countOf(code, 'this.cycleInFlight = true;');
    const setFalse = countOf(code, 'this.cycleInFlight = false;');
    const trueInCycle = countOf(inCycle.body, 'this.cycleInFlight = true;');
    const falseInCycle = countOf(inCycle.body, 'this.cycleInFlight = false;');
    if (setTrue !== 1) {
      problems.push(
        `全类有 ${setTrue} 处 \`this.cycleInFlight = true;\`（应恰好 1 处，在 inCycle 里）—— ` +
          '两处置真会让"早退"判据看到的状态不可信。',
      );
    }
    if (trueInCycle !== 1) problems.push(`inCycle() 里必须恰好 1 处置真，实际 ${trueInCycle} 处`);
    if (setFalse !== 1) {
      problems.push(
        `全类有 ${setFalse} 处 \`this.cycleInFlight = false;\`（应恰好 1 处）—— ` +
          '漏掉复位会让执行锁**再也不释放**（第一轮之后永远不再开新轮）。',
      );
    }
    if (falseInCycle !== 1) {
      problems.push(`inCycle() 里必须恰好 1 处复位，实际 ${falseInCycle} 处`);
    }
    const finallyAt = inCycle.body.indexOf('} finally {');
    const resetAt = inCycle.body.indexOf('this.cycleInFlight = false;');
    if (finallyAt < 0) problems.push('inCycle() 里找不到 `} finally {` —— 复位必须放在 finally 里');
    else if (resetAt < finallyAt) {
      problems.push('inCycle() 的复位**不在 finally 里** —— 抛错时执行锁就永久留着了');
    } else if (/\breturn\b/.test(inCycle.body.slice(finallyAt, resetAt))) {
      problems.push('inCycle() 的复位排在 finally 里的 `return` 之后 —— 那条路径不会复位');
    }
  }

  const tick = byName.get('tick');
  if (tick === undefined) {
    problems.push('找不到 tick() —— 结构变了，请更新本守卫');
  } else {
    const notRunningAt = tick.body.indexOf('if (!this.running) return;');
    if (notRunningAt < 0) {
      problems.push(`第 ${tick.startLine} 行：tick() 没有 \`if (!this.running) return;\` 早退`);
    }
    const cycleAt = tick.body.indexOf('if (this.cycleInFlight) {');
    if (cycleAt < 0) {
      problems.push(
        `第 ${tick.startLine} 行：tick() 没有 \`if (this.cycleInFlight) {...return;}\` 早退 —— ` +
          '这是**唯一**的轮次互斥；少了它，上一轮没跑完就会开下一轮。',
      );
    } else {
      const block = braceBlock(tick.body, tick.body.indexOf('{', cycleAt));
      if (block === null) problems.push('tick() 的 cycleInFlight 早退块取不到（括号不配平？）');
      else {
        if (!/\breturn\b/.test(block)) {
          problems.push(
            '第 ' + tick.startLine + ' 行：tick() 的 cycleInFlight 分支里没有 `return` —— ' +
              '它会继续往下跑，等于**没有早退**。',
          );
        }
        if (/scheduleNextCycle\(/.test(block)) {
          problems.push(
            'tick() 的 cycleInFlight 早退分支里排了下一轮 —— ' +
              '"跳过"会变成"推迟"，两个 tick 互相追着重排（排期风暴）。',
          );
        }
      }
      if (notRunningAt >= 0 && cycleAt < notRunningAt) {
        problems.push('tick() 里 `cycleInFlight` 早退排在 `!running` 早退之前 —— 停机时也会读在途状态');
      }
    }
    /* 排下一轮必须只在 running 时发生（否则 stop 之后还会继续跑）。 */
    for (const m of tick.body.matchAll(/this\.scheduleNextCycle\(/g)) {
      const at = m.index ?? 0;
      const before = tick.body.slice(Math.max(0, at - 300), at);
      if (!/if \(this\.running\)/.test(before)) {
        problems.push(
          `第 ${tick.startLine} 行附近：tick() 里的 \`scheduleNextCycle(\` 没有被 \`if (this.running)\` 包住 —— ` +
            '停机之后仍会排下一轮。',
        );
      }
    }
  }

  const runOnce = byName.get('runOnce');
  if (runOnce === undefined) problems.push('找不到 runOnce()');
  else if (!runOnce.body.includes('cycleInFlight') || !/throw\b/.test(runOnce.body)) {
    problems.push('runOnce() 没有拒绝重入（既没有读 cycleInFlight，也没有 throw）');
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/*  人造变异的文本手术（只改内存字符串，绝不写文件）                              */
/* -------------------------------------------------------------------------- */

function insertIntoMethod(code: string, methodName: string, snippet: string): string {
  const lines = code.split('\n');
  const m = methodsOf(code).find((x) => x.name === methodName);
  if (m === undefined) return code;
  lines.splice(m.startLine, 0, snippet);
  return lines.join('\n');
}

function dropLinesWith(code: string, methodName: string, needle: string): string {
  const lines = code.split('\n');
  const m = methodsOf(code).find((x) => x.name === methodName);
  if (m === undefined) return code;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const inMethod = i + 1 >= m.startLine && i + 1 <= m.endLine;
    if (inMethod && (lines[i] ?? '').includes(needle)) continue;
    kept.push(lines[i] ?? '');
  }
  return kept.join('\n');
}

/** 在某方法体内删掉一个整的花括号块（锚点 = 块首的 `if (...)` 文本）。 */
function dropBraceBlock(code: string, methodName: string, anchor: string): string {
  const m = methodsOf(code).find((x) => x.name === methodName);
  if (m === undefined) return code;
  const lines = code.split('\n');
  const startLine = m.startLine - 1;
  const bodyLines = lines.slice(startLine, m.endLine);
  const body = bodyLines.join('\n');
  const at = body.indexOf(anchor);
  if (at < 0) return code;
  const brace = body.indexOf('{', at);
  const block = braceBlock(body, brace);
  if (block === null) return code;
  const end = brace + block.length;
  const startOffset = body.slice(0, at).split('\n').length - 1;
  const endOffset = body.slice(0, end).split('\n').length - 1;
  const removed = bodyLines.slice(0, startOffset).concat(bodyLines.slice(endOffset));
  return lines.slice(0, startLine).concat(removed, lines.slice(m.endLine)).join('\n');
}

/* -------------------------------------------------------------------------- */
/*  断言                                                                       */
/* -------------------------------------------------------------------------- */

const CODE = stripCommentsKeepLines(RAW);

test('★★★ 轮次防重入四道闸门必须在位（静态结构）', () => {
  const all = methodsOf(CODE);
  assert.ok(all.length >= 90, `★ 只解析出 ${all.length} 个方法 —— 解析失效，本守卫会静默空转`);
  for (const name of ['start', 'stop', 'tick', 'inCycle', 'runOnce']) {
    assert.ok(all.some((m) => m.name === name), `★ 找不到 ${name}() —— 结构变了，请更新本测试`);
  }

  assert.deepEqual(
    reentrancyProblems(CODE),
    [],
    '★★★ 轮次防重入的闸门被破坏：\n' +
      reentrancyProblems(CODE).map((p) => `      · ${p}`).join('\n') +
      '\n    ⚠️ 两轮并行的后果不是"慢"，而是**绕过风控的单轮视角**：\n' +
      '      两轮各自认为空仓 → 各开一次仓（仓位翻倍，而风控只看单轮名义价值）。',
  );
});

test('★★★ 判据必须能真的报出问题 —— 五种人造变异逐一校准', () => {
  assert.deepEqual(reentrancyProblems(CODE), [], '★ 基线就有问题 —— 先修好再看校准');

  /* 变异 A：删掉 start() 的幂等检查。 */
  const mutatedA = dropLinesWith(CODE, 'start', 'if (this.running) return;');
  assert.notEqual(mutatedA, CODE, '★ 变异 A 没有生效（锚点文本变了？）');
  assert.ok(
    reentrancyProblems(mutatedA).some((p) => p.includes('start() 里没有')),
    '★★★ 变异 A（start 失去幂等）没被报出 —— 第 1 道闸门是空转',
  );

  /* 变异 B：删掉 tick() 的 cycleInFlight 早退（唯一的轮次互斥）。 */
  const mutatedB = dropBraceBlock(CODE, 'tick', 'if (this.cycleInFlight) {');
  assert.notEqual(mutatedB, CODE, '★ 变异 B 没有生效（锚点文本变了？）');
  assert.ok(
    reentrancyProblems(mutatedB).some((p) => p.includes('没有 `if (this.cycleInFlight)')),
    '★★★ 变异 B（tick 失去轮次互斥）没被报出 —— 第 3 道闸门是空转',
  );

  /* 变异 C：多一处置真（早退判据会看到不可信的状态）。 */
  const mutatedC = insertIntoMethod(CODE, 'inCycle', '    this.cycleInFlight = true;');
  assert.notEqual(mutatedC, CODE, '★ 变异 C 没有生效');
  assert.ok(
    reentrancyProblems(mutatedC).some((p) => p.includes('应恰好 1 处，在 inCycle 里')),
    '★★★ 变异 C（两处置真）没被报出',
  );

  /* 变异 D：排下一轮脱离 `if (this.running)`（停机后仍会排期）。 */
  const mutatedD = CODE.replace(
    '      if (this.running) {\n        this.scheduleNextCycle(failed, requested);\n      }',
    '      this.scheduleNextCycle(failed, requested);',
  );
  assert.notEqual(mutatedD, CODE, '★ 变异 D 没有生效（锚点文本变了？）');
  assert.ok(
    reentrancyProblems(mutatedD).some((p) => p.includes('没有被 `if (this.running)` 包住')),
    '★★★ 变异 D（排期不受 running 约束）没被报出',
  );

  /* 变异 E：删掉 inCycle() 的复位（执行锁再也不释放）。 */
  const mutatedE = dropLinesWith(CODE, 'inCycle', 'this.cycleInFlight = false;');
  assert.notEqual(mutatedE, CODE, '★ 变异 E 没有生效');
  assert.ok(
    reentrancyProblems(mutatedE).some((p) => p.includes('再也不释放')),
    '★★★ 变异 E（漏掉复位）没被报出',
  );
});
