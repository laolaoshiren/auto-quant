/**
 * **`fetchGuarded` 必须真的把连接层校验带上**（外部 issue #126 的接线那一环）。
 *
 * ## ⚠️ 这个测试是"变异测试"发现的盲区
 *
 * `dnsRebinding.test.ts` 覆盖的是 `guardedDispatcher()` **本身有效** ——
 * 它直接调 `undiciFetch(url, { dispatcher: guardedDispatcher([]) })`。
 *
 * 而我用变异测试验证那个守卫时，把 `fetchGuarded` 里 `fetch(...)` 的
 * **`dispatcher` 整个删掉**（即 DNS rebinding 防线在生产路径上完全失效）——
 * `dnsRebinding.test.ts` **仍然 7/7 全绿**。
 *
 * 原因：它测的是"dispatcher 拿到手就能挡"，**没测 `fetchGuarded` 是否真的把它交给了 fetch**。
 * **"判据函数对"与"接线接上了"是两件事** —— 后者错一处（忘了传、只在某一跳传、
 * 被后来的人删掉）就完全失效，而单元测试照样绿。
 *
 * ## ⚠️ 为什么这里用【结构断言】而不是功能测试
 *
 * 我先写了一版功能测试（起本地服务 + 用 `localhost` 请求），**它抓不到那个变异** ——
 * 因为 `localhost` 在 **`checkOutboundUrl` 的字面层**就已经被拦了，
 * 请求根本走不到连接层。所以"请求被拒"这个现象**无法区分**
 * "字面层拦的"与"连接层拦的"。
 *
 * 要功能性地测出连接层接线，需要一个**字面层放行、解析后落到内网**的地址 ——
 * 那需要可控 DNS（改 hosts / 用公开的 rebinding 域名），
 * 都会让测试依赖外部状态。所以改用**结构断言**：
 * 直接读 `http.ts` 的源码，确认 `fetchGuarded` 的 `fetch(...)` 调用里带 `dispatcher`。
 *
 * ⚠️ 这与 `receiptAdjustGate.test.ts` 里那条"回执的 adjust 要先过风控"是同一判断：
 * **接线用结构断言，逻辑用功能测试。** 两者都要有，因为它们的失效方式不同。
 *
 * ⚠️ 断言前**剥掉注释** —— 这个仓库的注释会逐字引用被讨论的代码
 *（本文件上方就引用了 `fetch(...)` 的片段），不剥会让判据被自己的注释命中。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('./http.ts', import.meta.url), 'utf8');

/** 剥掉行注释与块注释（本仓库注释会逐字引用代码）。 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

/** 取 `fetchGuarded` 的函数体（到下一个顶层 `function`/`export` 声明为止）。 */
function fetchGuardedBody(): string {
  const start = SRC.indexOf('export async function fetchGuarded(');
  assert.ok(start > 0, '找不到 `fetchGuarded` —— 结构变了，请更新本测试');
  /* 到下一个顶层函数声明为止。 */
  const rest = SRC.slice(start + 10);
  const next = rest.search(/\n(?:export )?(?:async )?function [a-zA-Z]/);
  return stripComments(SRC.slice(start, next > 0 ? start + 10 + next : SRC.length));
}

test('★★★ `fetchGuarded` 的每一次 fetch 都必须带 `dispatcher` —— 否则连接层防线在生产路径上失效', () => {
  const body = fetchGuardedBody();

  /*
   * ⚠️ 判据是"**每一个** `fetch(…)` 调用点附近都有 `dispatcher`" ——
   * 而不是"文件里出现过 dispatcher"。后者会被
   * （a）上面那句 `const dispatcher = guardedDispatcher(...)` 的**定义**、或
   * （b）别处的用法命中，从而在真正漏传时**照样通过**。
   */
  const fetchCalls = [...body.matchAll(/\bawait fetch\(/g)];
  assert.ok(
    fetchCalls.length >= 1,
    '★★ 在 `fetchGuarded` 里找不到 `await fetch(` 调用 —— 结构变了，请更新本测试',
  );

  for (const call of fetchCalls) {
    /* 取这次调用的实参区（到匹配的右括号为止）。 */
    const open = body.indexOf('(', call.index);
    let depth = 0;
    let end = open;
    for (let i = open; i < body.length; i += 1) {
      const ch = body[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const args = body.slice(open, end + 1);
    assert.match(
      args,
      /\bdispatcher\b/,
      '★★★ `fetchGuarded` 的 `fetch(...)` **没有传 `dispatcher`** ——\n' +
        '    连接层校验（`guardedDispatcher`）就完全没有生效，DNS rebinding 防线在生产路径上消失。\n' +
        '    ⚠️ 这个变异**不会**让 `dnsRebinding.test.ts` 变红（它直接调 undiciFetch），\n' +
        '    所以必须由这条结构断言守着。\n' +
        `    实际实参：${args.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
  }
});

test('★★★ `fetchGuarded` 必须在【循环之前】构造一次 dispatcher —— 每一跳共用它', () => {
  /*
   * ⚠️ 这条防的是另一种退化：把 `guardedDispatcher(...)` 塞进循环体里。
   * 那样**每一跳都新建一个 Agent** —— 连接池被丢掉（每次重定向都重新握手），
   * 而且掩蔽了"共用一份判据"这个意图。
   */
  const body = fetchGuardedBody();
  const constructIdx = body.indexOf('guardedDispatcher(');
  assert.ok(constructIdx > 0, '★★★ `fetchGuarded` 里找不到 `guardedDispatcher(` 的构造');

  const loopIdx = body.indexOf('for (');
  assert.ok(loopIdx > 0, '★ 找不到重定向循环 —— 结构变了');
  assert.ok(
    constructIdx < loopIdx,
    '★★★ `guardedDispatcher(...)` 必须在重定向循环**之前**构造一次 —— ' +
      '放进循环里会让每一跳都新建连接池（丢 keep-alive），也掩蔽了"共用一份判据"',
  );
});

test('★★ 剥注释这件事本身有效 —— 否则判据会被自己的注释命中', () => {
  /*
   * 反向守卫：本文件上方的注释里就引用了 `fetch(...)` 的片段。
   * 若 `stripComments` 失效，那条断言可能在真正漏传时**照样通过**
   *（因为注释里的示例代码带了 dispatcher）。
   */
  const fake = [
    '/**',
    ' * 示例：',
    ' *   await fetch(url, { dispatcher });',
    ' */',
    'function sample() {',
    '  await fetch(url);',
    '}',
  ].join('\n');
  const stripped = stripComments(fake);
  assert.doesNotMatch(stripped, /dispatcher/, '★★ 注释里的示例必须被剥掉，否则判据会被它命中');
});
