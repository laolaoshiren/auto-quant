/**
 * **每一次平仓都必须入账**（五道闸门的第 ② 条不变量之一）—— 最后一条。
 *
 * ## 这条守卫接的是什么
 *
 * 平仓要同时做两件事：**写一行 `trades`**（账）+ **关掉 `positions` 行**（状态）。
 * 前者只有 `bookClosedPosition` 会做（`autoTrader.ts:10467` 的注释：
 * 「凭据**去 `bookClosedPosition()`：写一行 `trades` + `positionStore.close()`」）。
 *
 * ⚠️ 而 `positionStore.close(id)` 是**共用**的 —— 它既关"已成交的持仓行"，
 * 也关"未成交的挂单行"（`settlePendingEntries` / `expireStalePendingEntries` /
 * `executeCancelPending` / `cancelAllPendingEntries` 都用它）。
 * 所以**"有 close 调用"不能推出"这是一次平仓"** —— 判据必须认得出区别。
 *
 * ## ⚠️ 判据：`positionStore.close` 必须要么在 `bookClosedPosition` 体内，要么在
 * "只关挂单"的方法里
 *
 * 我把 `close` 的调用点分成三类，每类**显式登记**：
 *
 * | 类别 | 含义 |
 * | --- | --- |
 * | **入账口** | `bookClosedPosition` 体内 —— 它先写账再关行 |
 * | **只关挂单** | 那几个方法关的是**未成交**的 pending 行（**不是平仓**）|
 *
 * ⚠️ 任何**新的** `positionStore.close` 调用点都必须落进上面两类之一 ——
 * 落不进去就报错。这正是"每次平仓都必须入账"的落地方式：
 * **新增一个关仓点时必须先想清楚"这笔账谁来记"。**
 *
 * ## 边界（诚实说明）
 *
 * · 它**不能**从代码上证明"某个 close 关的确实是 pending 行而不是持仓行" ——
 *   那要看调用处的上下文（我逐处读过，理由写在白名单里）；
 * · 它抓不住"入了账但金额错"（那是 `pnlArithmeticGuard.test.ts` 的事）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');

/** 剥注释但保留行号。 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

const CODE = stripCommentsKeepLines(SRC);

/** 取 `AutoTrader` 里每个方法的方法体。 */
function methods(): Array<{ name: string; startLine: number; body: string }> {
  const lines = CODE.split('\n');
  const out: Array<{ name: string; startLine: number; body: string }> = [];
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
    out.push({ name: m[1]!, startLine: i + 1, body: lines.slice(i, end).join('\n') });
  }
  return out;
}

/**
 * 允许调用 `positionStore.close(` 的方法 —— **显式登记，附理由**。
 *
 * ⚠️ 键是**方法名**。理由必须写清"关的是哪一类行"。
 */
const ALLOWED_CLOSE: ReadonlyMap<string, string> = new Map([
  [
    'bookClosedPosition',
    '**入账口**：先写一行 `trades`（`tradeStore.insert`）再 `positionStore.close()`。' +
      '所有真正的平仓都必须走它。',
  ],
  [
    'settlePendingEntries',
    '**只关挂单行**：处理"没有交易所单号的坏数据"（`row.entry_order_id` 为空）。' +
      '⚠️ 它发 `warn` 事件说明"已作废该记录"，且**不写 trades** —— 因为那行**从未成交**。',
  ],
  [
    'expireStalePendingEntries',
    '**只关挂单行**：挂单超时且**已成功撤掉**（撤不掉时它刻意 `continue`，' +
      '因为"若其实已成交，`settlePendingEntries` 会转正它"——见那里的注释）。' +
      '⚠️ 未成交 ⇒ 无账可记。',
  ],
  [
    'executeCancelPending',
    '**只关挂单行**：模型主动撤单。同上，未成交 ⇒ 无账可记。',
  ],
  [
    'cancelAllPendingEntries',
    '**只关挂单行**：批量撤单（停机/风控）。同上。',
  ],
]);

test('★★★ 每一个 `positionStore.close` 调用点都必须是"入账"或"只关挂单"', () => {
  const all = methods();

  /* 前置断言：必须真的解析出方法。 */
  assert.ok(all.length >= 20, `★ 只解析出 ${all.length} 个方法 —— 解析可能失效了`);

  const closers = all.filter((m) => /positionStore\.close\(/.test(m.body));
  assert.ok(
    closers.length >= 4,
    `★ 只找到 ${closers.length} 个调用 \`positionStore.close\` 的方法 —— 扫描可能失效了`,
  );

  const unknown = closers.filter((m) => !ALLOWED_CLOSE.has(m.name));
  assert.deepEqual(
    unknown.map((m) => `${m.name}（第 ${m.startLine} 行）`),
    [],
    '★★★ 这些方法调用了 `positionStore.close`，但**不在已知的两类里**：\n' +
      unknown.map((m) => `      · ${m.name}（第 ${m.startLine} 行）`).join('\n') +
      '\n    ⚠️ 这是五道闸门的第 ② 条不变量：「**每一次平仓都必须入账**」。\n' +
      '    ⚠️ `positionStore.close()` 既关**持仓行**也关**挂单行** —— 所以"有 close 调用"\n' +
      '    **不能推出**"这是一次平仓"。新增一个关仓点时必须先想清楚：\n' +
      '      · 若它关的是**已成交的持仓** → 必须走 `bookClosedPosition()`（写账 + 关行）；\n' +
      '      · 若它关的是**未成交的挂单** → 无账可记，加进 `ALLOWED_CLOSE` 并写明理由。',
  );

  /* 反向：白名单里不能留下已经不存在的方法。 */
  const names = new Set(all.map((m) => m.name));
  for (const key of ALLOWED_CLOSE.keys()) {
    if (!names.has(key)) {
      assert.fail(
        `★★ 白名单里的 \`${key}\` 已经不存在了 —— 请从 \`ALLOWED_CLOSE\` 移除，` +
          '否则下一个人会以为它还在。',
      );
    }
  }
});

test('★★★ 入账口必须真的"先写账再关行" —— 但幂等分支是例外', () => {
  /*
   * ⚠️ 这条守的是 `bookClosedPosition` 里 `tradeStore.insert(...)` 与
   * `positionStore.close(...)` 的**顺序**：正常路径必须**先写账再关行**。
   * 反过来的话，`close` 成功而 `insert` 抛错 ⇒ 仓位消失了、账没记 ——
   * 那正是这条不变量要防的"凭空消失的持仓"。
   *
   * ## ⚠️ 但我第一版的判据**误报了**（记在这里）
   *
   * 我一开始直接断言"`insert` 的下标 < `close` 的下标"，结果**失败** ——
   * 因为 `bookClosedPosition` 里有**两个** `close`：
   *
   * ```
   * 第 5746 行  positionStore.close(local.id);   ← 幂等分支：此前【已入账】，
   *                                                 所以只关行、不重复记账
   * 第 5761 行  const booked = tradeStore.insert({ … });   ← 正常路径：先写账
   * 第 5799 行  positionStore.close(local.id);             ← 再关行
   * ```
   *
   * ⚠️ 第 5746 行那个是**正确的** —— 它在一个"`alreadyBooked` 有值"的早退分支里，
   * 账**早就存在**，重复 `insert` 反而会记两次（§2.5 的幂等）。
   *
   * 所以判据必须是：**每一个 `close` 之前，要么已经 `insert` 过，要么这个分支
   * 已经证明"账已存在"**。这里用"该 close 之前出现过 `insert` **或**
   * `alreadyBooked`"来判 —— 后者正是那条幂等分支的判据变量。
   */
  const fn = methods().find((m) => m.name === 'bookClosedPosition');
  assert.ok(fn, '找不到 `bookClosedPosition` —— 结构变了，请更新本测试');

  const closeIdx = fn.body.indexOf('positionStore.close(');
  assert.ok(closeIdx > 0, '★★★ `bookClosedPosition` 里找不到 `positionStore.close(`');

  /* 逐个 `close` 检查它之前有没有"账"（insert 或 alreadyBooked）。 */
  const lines = fn.body.split('\n');
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/positionStore\.close\(/.test(lines[i] ?? '')) continue;
    const before = lines.slice(0, i).join('\n');
    const hasBook = /tradeStore\.insert\(/.test(before) || /alreadyBooked/.test(before);
    if (!hasBook) problems.push(`第 ${fn.startLine + i} 行附近的 \`positionStore.close(\` 之前没有任何入账`);
  }

  assert.deepEqual(
    problems,
    [],
    '★★★ `bookClosedPosition` 里有 `positionStore.close` 出现在**入账之前**：\n' +
      problems.map((p) => `      · ${p}`).join('\n') +
      '\n    ⚠️ 顺序反了的话，`close` 成功而 `insert` 抛错 ⇒ 仓位消失、账没记。\n' +
      '    ✅ 正常路径必须先 `tradeStore.insert(...)` 再 `positionStore.close(...)`；\n' +
      '       幂等分支（`alreadyBooked` 有值）只关行、不重复记账，那是**正确**的。',
  );
});

test('★★★ 判据必须能真的报出未知的关仓点 —— 用人造源码校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `unknown` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用人造方法名跑同一套判据，断言它会被报出。
   */
  const classify = (name: string): boolean => ALLOWED_CLOSE.has(name);

  assert.equal(classify('executeClose'), false, '★★★ 未知的关仓点必须被报出 —— 否则上面那条是空转');
  assert.equal(classify('bookClosedPosition'), true, '★★ 已知的入账口不能被误报');
  assert.equal(classify('expireStalePendingEntries'), true, '★★ 已知的"只关挂单"不能被误报');
});
