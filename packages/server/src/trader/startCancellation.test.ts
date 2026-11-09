/**
 * **启动飞行中收到的「停止」必须生效**（外部 issue #143，真实资金）。
 *
 * ## 为什么必须有这条测试
 *
 * `attemptStart()` 的启动窗口实测是「几秒到几十秒」（建连接、校时、`exchangeInfo`、
 * 模型探测、拉持仓对账）。操作员在这个窗口里点「停止」时：
 *
 * ```
 *   stopTrader()                      ← 第一句就 cancelledStarts.add(traderId)
 *     this.running.get(traderId)      ← undefined（实例还没被写进去）
 *     → 走 else：只写一个 'stopped' 状态就返回
 *   …
 *   attemptStart() 仍在 await 中
 *     this.running.set(...)           ← 照常把实例放进去
 *     await autoTrader.start()        ← 照常起交易循环，**用真钱开始下单**
 * ```
 *
 * 也就是说：**界面显示已停止，而机器人几秒后真的开单**。
 * 这比"停止按钮反应慢"严重得多 —— 它给出的是**已停止的假象**。
 *
 * 更糟的是 `startTrader` 的 `finally` 会 `cancelledStarts.delete(traderId)`，
 * 于是这条停止意图**连痕迹都不留**。
 *
 * ## 为什么这条测试是「源码结构断言」而不是行为测试
 *
 * `attemptStart()` 要真实建交易所连接（校时、`exchangeInfo`、拉持仓对账）才能
 * 走到那几行，单测里无法在不打桩半个交易所的前提下到达 —— 而打桩到那个程度之后，
 * 被测的就变成了桩，不是这段守卫。
 *
 * 这与同目录既有的 `researchLifecycle.test.ts` 是**同一类判断**：
 * 那一份防的是"清理函数定义了但没人调用"，这一份防的是"取消标志存在但没被检查" ——
 * 两者都是**接线缺陷**，而接线缺陷的可观测面就在源码结构上。
 *
 * ⚠️ 所以本文件断言的是「守卫存在且位置正确」，它**不能**证明运行时行为。
 *
 * ## ⚠️ 为什么用「相对顺序」而不是「提取函数体」
 *
 * 第一版试图按大括号配平切出 `attemptStart` 的函数体，结果连错两次：
 * ① 用 `'\n  /**'` 当边界 —— 函数体内部就有块注释（本仓库注释密度很高），被提前截断；
 * ② 改成大括号配平 —— 参数表与返回类型里的 `{ }`（`): Promise<{ result… }>`）
 *    会先把 depth 配平归零。
 *
 * 结论：**用文本手段可靠地解析 TypeScript 结构，比被测的那件事还容易出错。**
 * 这里改成最朴素也最稳的做法 —— 在**整个文件**里比较几个锚点的出现顺序，
 * 并限定在 `attemptStart` 到下一个方法声明之间。断言失败时给出行号，便于人工核对。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

/** 1-based 行号（便于把断言失败直接对到源码）。 */
function lineOf(index: number): number {
  return SRC.slice(0, index).split('\n').length;
}

/**
 * `attemptStart` 起止之间那一段。
 *
 * ⚠️ **不要用「下一个 `\n  async `」当边界** —— 试过两次都错：
 * ① 用 `'\n  /**'`：函数体内部就有块注释（本仓库注释密度很高），被提前截断；
 * ② 用 `'\n  async '`：`attemptStart` 与下一个真方法之间还夹着别的成员，
 *    而 `slice(start + 10)` 之后的相对偏移算出来会落到**另一个方法**上
 *    （实测命中了 `stopTrader`，于是 span 把守卫与 `start()` 一起切掉了）。
 *
 * 所以这里**不猜边界**：直接把「`attemptStart` 声明」到「`stopTrader` 声明」之间
 * 那一段当作搜索范围 —— 那正是启动逻辑所在，且两个锚点都是**唯一**的完整签名。
 * 断言失败时打印行号，便于人工核对。
 */
function attemptStartSpan(): { start: number; end: number; text: string } {
  const start = SRC.indexOf('private async attemptStart(');
  assert.ok(start > 0, '找不到 attemptStart —— 方法被改名了？');
  const end = SRC.indexOf('async stopTrader(traderId: number)', start);
  assert.ok(end > start, '找不到 attemptStart 之后的 stopTrader —— 结构变了？');
  return { start, end, text: SRC.slice(start, end) };
}

test('★★★ attemptStart 必须在启动交易循环前检查取消标志（否则停止被完全忽略）', () => {
  const { text } = attemptStartSpan();

  /*
   * 只断言"文件里某处有 cancelledStarts"是不够的 —— 那正是缺陷原状：
   * 修复前它有 4 处读点，全在**失败分支**与 `resumePersisted` 里，
   * 成功路径一处都没有。
   */
  assert.ok(
    text.includes('cancelledStarts.has(traderId)'),
    '★★★ attemptStart 里必须读 cancelledStarts —— 否则启动飞行中点「停止」会被完全忽略，机器人照样起循环并用真钱下单',
  );
  assert.ok(
    text.includes('this.stopping'),
    '★★★ attemptStart 里还必须读 this.stopping —— 停机流程（stopAll）同理需要它能打断飞行中的启动',
  );
});

test('★★★ 取消检查必须在 `autoTrader.start()` 之前，不能只写在别处', () => {
  const { text } = attemptStartSpan();

  /* 只找**真的 if 条件**：注释里提到这个表达式是正常的（本修复写了很长的解释），
     拿 `indexOf` 找第一次出现会命中注释，断言就变成在测"注释里有没有这行字"。 */
  const guardMatch = /if\s*\(\s*this\.cancelledStarts\.has\(traderId\)/.exec(text);
  assert.ok(
    guardMatch,
    '找不到 `if (this.cancelledStarts.has(traderId) …)` 形式的守卫 —— 注释里提到不算接线',
  );

  /*
   * ⚠️ **`await autoTrader.start()` 在源码里出现多次**（本修复的注释里也引用了它），
   * 所以必须取**真正的调用行**，不能拿 `indexOf` 的第一次命中 ——
   * 否则会命中注释、算出"守卫在 start() 之后"的假结论。
   *
   * 真正的调用行以 `await autoTrader.start();` 结尾且不在注释里（不以 `*` 开头）。
   */
  const callIdx = text
    .split('\n')
    .reduce<{ at: number; offset: number } | null>((found, line, _i, _arr) => {
      if (found) return found;
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return null;
      if (trimmed === 'await autoTrader.start();') {
        const at = text.indexOf(line);
        return { at, offset: at };
      }
      return null;
    }, null);
  assert.ok(callIdx, '找不到真正的 `await autoTrader.start();` 调用行 —— 结构变了，请更新本测试');

  const runningSetIdx = text.indexOf('this.running.set(traderId, autoTrader)');
  assert.ok(runningSetIdx > 0, '找不到 `this.running.set(traderId, autoTrader)`');

  assert.ok(
    guardMatch.index < callIdx.at,
    `第一道取消检查必须在 \`await autoTrader.start()\` 之前 —— 起了循环才发现被取消，` +
      `已经晚了一步（那一轮可能已经下单）。守卫在第 ${lineOf(guardMatch.index)} 行，` +
      `start() 在第 ${lineOf(callIdx.at)} 行`,
  );
  assert.ok(
    runningSetIdx < callIdx.at,
    '前提：`running.set` 在 `start()` 之前（本测试依赖这个结构）',
  );
});

test('★★★ 取消导致的失败必须标记 permanent —— 否则会被启动重试逻辑否决', () => {
  const { text } = attemptStartSpan();
  /*
   * `startTrader` 的重试判据是 `!outcome.permanent && !cancelledStarts.has(id) && …`
   * （见同文件里的 `canRetry`）。若取消分支返回的 `permanent` 是 false，
   * 那么"停止"会被重试机制重新拉起 —— 等于**停止请求被系统否决**。
   */
  assert.ok(
    /permanent:\s*true/.test(text),
    '★★★ 取消分支必须返回 permanent: true —— 否则 startTrader 的重试逻辑会把它重新拉起来（停止被否决）',
  );
});

test('★★★ 取消分支必须清理 running，不能留半启动的实例', () => {
  const { text } = attemptStartSpan();
  /*
   * 若取消分支只 `return` 而不把刚写进去的实例摘掉，`statusOf()` 会一直读它，
   * 界面显示"运行中"，而实际上从没启动过 —— 又一种自相矛盾的状态。
   */
  assert.ok(
    text.includes('this.running.delete(traderId)'),
    '★★★ 取消分支必须把实例从 running 摘掉 —— 否则界面会显示一个从没启动过的"运行中"',
  );
});

test('★★★ 停止飞行中的启动时，persist 必须是 true（这是「操作员点的停止」）', () => {
  const { text } = attemptStartSpan();
  /*
   * `AutoTrader.stop(reason, persist)` 的文档写明 `persist: false` 是**给进程关闭用的**：
   * `resumePersisted()` 只恢复 `running` / `safe_mode` / `error`，**刻意不恢复 `stopped`**
   * —— 因为那被当作操作员的决定。
   *
   * 所以若这里传 `false`，操作员的停止意图会被丢掉，**下一次部署或重启就把这台
   * 机器人又拉起来**。而本守卫的语义恰恰是"操作员在启动途中点了停止"。
   */
  assert.ok(
    !/autoTrader\.stop\([^)]*,\s*false\s*\)/.test(text),
    '★★★ 取消分支不能给 autoTrader.stop 传 persist=false —— 那是进程关闭的语义，会把操作员的停止意图丢掉',
  );
  assert.ok(
    /autoTrader\.stop\([^)]*,\s*true\s*\)/.test(text),
    '★★★ 取消分支必须显式传 persist=true（操作员点的停止要落库，否则重启后被 resumePersisted 拉起）',
  );
});

test('★★★ 新的启动请求必须先清掉上一轮「停止」留下的取消旗标', () => {
  /*
   * 2026-11-10 浏览器回归实测的真实 BUG（不是推测）：
   *
   *   startTraderAsync() → startTrader() 的 finally 才会 `cancelledStarts.delete()`
   *   stopTrader()      → 第一句 `cancelledStarts.add()`
   *
   * 于是「启动 → 停止 → **马上再启动**」时，新启动在 `attemptStart()` 的守卫处
   * 读到的是**上一轮停止**留下的旗标 → 判定"启动过程中收到停止" → 静默取消，
   * 状态保持 stopped。用户看到的是「点了启动，什么都没发生」；实测日志只有
   * 「启动过程中收到「停止」—— 已放弃本次启动」。更糟的是那面旗子在下次
   * `startTrader` 退出前一直存在 —— **停止之后的下一次启动必被取消**。
   *
   * 修复：`startTraderAsync()` 在开始一次新的启动时删掉它。语义是"操作员
   * 最新的意图是启动"，而上一轮停止已经兑现（`running` 已被删）。
   * 停止若发生在**这次启动之后**，`stopTrader` 会重新 add —— 飞行中停止的
   * 第二道守卫不受影响（见本文件其它用例）。
   */
  const asyncStart = SRC.indexOf('startTraderAsync(traderId: number, dryRun: boolean): StartResult {');
  assert.ok(asyncStart > 0, '找不到 startTraderAsync —— 方法被改名了？');
  const callStart = SRC.indexOf('void this.startTrader(traderId, dryRun)', asyncStart);
  assert.ok(callStart > asyncStart, '找不到 startTraderAsync 里对 startTrader 的调用 —— 结构变了？');
  const text = SRC.slice(asyncStart, callStart);
  const deleteIdx = text.indexOf('cancelledStarts.delete(traderId)');
  assert.ok(
    deleteIdx > 0,
    '★★★ 新启动必须先清掉上一轮停止的取消旗标 —— 否则「停止 → 再启动」会被上一轮停止静默取消（界面无任何提示）',
  );
  const guardIdx = text.indexOf('if (!guard.ok) return');
  assert.ok(
    guardIdx >= 0 && deleteIdx > guardIdx,
    '★ 清理必须发生在启动守卫之后（被守卫拒绝的请求不该去动状态）',
  );
});
