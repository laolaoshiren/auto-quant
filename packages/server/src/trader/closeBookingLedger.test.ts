/**
 * **每一次真实平仓都必须写一行 `trades`**（五道闸门的第 ② 条不变量）—— 账目侧的那一半。
 *
 * ## 它补的是 `closeBookingGuard.test.ts` 够不到的那一段
 *
 * `closeBookingGuard` 守的是：**`positionStore.close()` 的调用点必须落在白名单里**。
 * 那是必要的，但**不够** —— 它只能证明"关行的那些地方是已知的"，
 * 证明不了"**关掉一行真实持仓时，账也记了**"。
 *
 * 历史事故（本仓库自己记下来的，`autoTrader.ts` 里那段英文注释 + `schema.ts` 的注释）：
 * ```
 *   停机期间仓位被交易所的止损平掉
 *     → 本地那行仓位"消失"，而没有任何一行 trades
 *     → 账本比交易所少了整整一笔（实测 +0.2586 vs −0.3136）
 * ```
 * 也就是说：**"仓位行没了"与"账记了"是两件事，而它们必须同时发生。**
 *
 * ## 判据（四层，全部"穷举 + 显式登记 + 人造校准"）
 *
 * | 层 | 判据 | 抓什么 |
 * | --- | --- | --- |
 * | ① | 写账点穷举：`tradeStore.insert(` 只允许出现在登记的方法里 | 有人从**新地方**写账（绕开入账口） |
 * | ② | 关行点穷举：`positionStore.close(` 只允许出现在登记的方法里 | 新增关仓点（与 closeBookingGuard 同一份事实，重复断言是**故意的**：两份判据都必须基于同一张表） |
 * | ③ | **"只关挂单"的方法里不许出现写账** | 把一次真实平仓误分类成"挂单作废"（那正是账号消失的形状） |
 * | ④ | **消失路径必须能走到入账口**（调用图可达性） | 把 `reconcilePositions → bookVanishedPosition → bookClosedPosition` 这条链**断掉** |
 * | ⑤ | **真实通路必须存在**（可达性时避开"只在 dryRun 走"的结算通路） | 第 ④ 层被一条**实盘根本不会走**的通路救活（"静默失效"的经典形状） |
 *
 * ⚠️ 第 ④ 层是这份守卫**独有的价值**：前三层都是"逐点登记"，
 * 只有它守的是**"停了的那条路"** —— 停机期间交易所平仓、模拟盘结算、
 * 紧急铺平这三条路径都必须能走到 `bookClosedPosition()`。
 *
 * ## 它抓不到什么（诚实说明）
 *
 * · **金额/价格对不对** —— 那是 `pnlArithmeticGuard.test.ts` 的事；
 * · **"某次平仓根本没有对应的本地仓位行"** —— 没有行就无从追踪（那要靠对账的
 *   `reconcileTradeHistory` 从交易所流水重建，本守卫只能证明"重建路径存在"）；
 * · **运行时才会暴露的分支** —— 这里只做静态结构扫描，不执行 `AutoTrader`；
 * · **有人把新方法同时加进两张登记表** —— 登记是**人的显式动作**（带理由），
 *   守卫只能保证"不做这个动作就会被拦下"。
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

/**
 * 取 `AutoTrader` 里每个方法的方法体。
 *
 * ⚠️ 与 `closeBookingGuard.test.ts` 里的同名实现在**判据上必须一致** ——
 * 两份各写一遍会漂移（本仓库为"同一概念两处实现"付过代价），
 * 所以这里连前置断言（方法数下限）都保留着：解析失效必须**报错**，不能静默返回空。
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

/* -------------------------------------------------------------------------- */
/*  两张登记表（键=方法名，值=理由）                                            */
/* -------------------------------------------------------------------------- */

/**
 * 允许写 `trades` 的方法 —— **显式登记，附理由**。
 *
 * 新增一处写账点时必须先想清楚：**这笔账能不能走已有的入账口？**
 * 若不能（像"部分平仓"那样仓位还开着），就加进来并写清理由。
 */
const ALLOWED_TRADE_INSERT: ReadonlyMap<string, string> = new Map([
  [
    'bookClosedPosition',
    '**平仓入账口**：一次真实平仓在这里写一行 `trades`（`booked` 有值时幂等跳过），' +
      '且它是唯一"先写账再关行"的地方。所有真实平仓都必须走它。',
  ],
  [
    'reconcileTradeHistory',
    '**历史重建**：停机期间的成交在本地没有对应仓位行，只能按交易所流水重建 —— ' +
      '见 `autoTrader.ts` 里那段 `reconcileTradeHistory` 顶部的事故说明。',
  ],
  [
    'executeReduce',
    '**部分平仓**：减仓当场记一笔（`close_reason=manual_partial`），' +
      '而**仓位仍开着** —— 所以它不能走 `bookClosedPosition()`（那会连行一起关掉）。',
  ],
]);

/**
 * 允许关掉本地 `positions` 行的方法 —— **显式登记，附理由**。
 *
 * ⚠️ 这张表与 `closeBookingGuard.test.ts` 的 `ALLOWED_CLOSE` 是**同一份事实**。
 * 两份重复是刻意的（那份守"分类"，这份守"分类之后账有没有记"），
 * 但**任何一处新增都必须同时改两处** —— 这也是本文件要断言"表内容一致"的原因。
 */
const ALLOWED_POSITION_CLOSE: ReadonlyMap<string, string> = new Map([
  ['bookClosedPosition', '**入账口**：真实平仓的唯一出口（写账 + 关行）。'],
  ['settlePendingEntries', '**只关挂单行**：从未成交的坏数据记录，无账可记。'],
  ['expireStalePendingEntries', '**只关挂单行**：挂单超时且已撤掉，无账可记。'],
  ['executeCancelPending', '**只关挂单行**：模型主动撤单，无账可记。'],
  ['cancelAllPendingEntries', '**只关挂单行**：批量撤单（停机/风控），无账可记。'],
]);

/** 只关挂单、**绝不该写账**的方法（从上面那张表推出来，不手写第二份）。 */
const PENDING_ONLY: readonly string[] = [...ALLOWED_POSITION_CLOSE.entries()]
  .filter(([name]) => name !== 'bookClosedPosition')
  .map(([name]) => name);

/**
 * **会把"本地有、交易所没有"判成消失**的路径 —— 每一条都必须能走到入账口。
 *
 * 这张表就是历史事故的清单化：停机期间被交易所平掉、模拟盘结算、紧急铺平。
 * ⚠️ 判据是**调用图可达**，不是"直接调了" —— 中间多一层（`flattenAndBook`）也算。
 */
const MUST_REACH_BOOKING: ReadonlyMap<string, string> = new Map([
  ['reconcilePositions', '**停机期间被交易所平掉** → 必须入账（这就是历史事故那条路）。'],
  ['reconcileTradeHistory', '停机期间的成交只能靠流水重建 → 必须能入账。'],
  ['bookVanishedPosition', '"仓位消失"的唯一出口 —— 它只做判因，账交给入账口。'],
  ['settleDryRunPositions', '模拟盘没有交易所持仓，平仓判定只能走本地。'],
  ['flattenAndBook', '紧急/强制铺平。'],
  ['executeClose', '模型主动平仓。'],
  ['executeOpen', '开仓前发现交易所已有反向仓位 → 先平掉再开。'],
  ['executeAdd', '加仓前的对冲平仓。'],
  ['executeReduce', '减仓。'],
  ['executeAdjust', '调整保护位失败后的收尾平仓。'],
  ['applyBreakevenGuard', '保本止损触发后的平仓。'],
  ['closeManually', '人工平仓。'],
]);

/* -------------------------------------------------------------------------- */
/*  纯函数判据（可被"人造源码"校准）                                            */
/* -------------------------------------------------------------------------- */

/** 一个方法体里出现的 `this.<name>(` 调用目标（去重、保序）。 */
function calleesOf(member: Member, all: readonly Member[]): string[] {
  const names = new Set(all.map((m) => m.name));
  const found: string[] = [];
  for (const m of member.body.matchAll(/this\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const n = m[1]!;
    if (names.has(n) && !found.includes(n)) found.push(n);
  }
  return found;
}

/** 调用图可达性：`from` 能否（经 0..N 跳）走到 `to`；`avoid` 里的方法**不许经过**。 */
function reachesAvoiding(
  code: string,
  from: string,
  to: string,
  avoid: ReadonlySet<string> = new Set(),
): boolean {
  const all = methodsOf(code);
  const byName = new Map(all.map((m) => [m.name, m]));
  if (!byName.has(from) || !byName.has(to) || avoid.has(from)) return false;
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) return true;
    const member = byName.get(cur);
    if (member === undefined) continue;
    for (const next of calleesOf(member, all)) {
      if (seen.has(next) || avoid.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

function reaches(code: string, from: string, to: string): boolean {
  return reachesAvoiding(code, from, to);
}

/**
 * **真实（非模拟盘）平仓路径** —— 必须存在一条**不经过模拟盘结算**的入账通路。
 *
 * ## 为什么需要"避让"这一层（否则判据会被一条假通路救活）
 *
 * `reconcilePositions` 同时挂着两条关仓通路：
 * ```
 *   ① 交易所已平、本地还在 → bookVanishedPosition() → bookClosedPosition()   ← 实盘走这条
 *   ② 模拟盘结算           → settleDryRunPositions() → bookClosedPosition()  ← 只在 dryRun 走
 * ```
 * 若只判"能到达入账口"，那么**把 ① 删掉**之后 ② 仍然让它通过 ——
 * 判据被一条**实盘根本不会走**的通路救活（"静默失效"的经典形状）。
 * 所以这两条路径必须**避开 `settleDryRunPositions`** 也能到达入账口。
 */
const REAL_PATH_MUST_REACH_BOOKING: ReadonlyMap<string, string> = new Map([
  ['reconcilePositions', '**停机期间被交易所平掉**的仓位必须入账 —— 而模拟盘结算通路在实盘不会走。'],
  ['reconcileTradeHistory', '停机期间的成交只能靠流水重建 → 真实通路也必须能入账。'],
]);

/** 模拟盘专用通路（判"真实通路"时要避开它）。 */
const DRY_RUN_ONLY: ReadonlySet<string> = new Set(['settleDryRunPositions']);

/** 跑一遍全部判据，返回问题清单（`行号：说明`）。 */
function ledgerProblems(code: string): string[] {
  const all = methodsOf(code);
  const problems: string[] = [];

  /* ── ① 写账点穷举 ───────────────────────────────────────────────── */
  const inserters = all.filter((m) => /tradeStore\.insert\(/.test(m.body));
  for (const m of inserters) {
    if (!ALLOWED_TRADE_INSERT.has(m.name)) {
      problems.push(
        `第 ${m.startLine} 行：${m.name} 写了 trades，但没有登记 —— 这笔账为什么不能走 bookClosedPosition()？`,
      );
    }
  }
  /* 反向：登记表里不能留已经不存在的方法。 */
  const names = new Set(all.map((m) => m.name));
  for (const key of ALLOWED_TRADE_INSERT.keys()) {
    if (!names.has(key)) problems.push(`登记表 ALLOWED_TRADE_INSERT 里的 ${key} 已经不存在了 —— 请移除`);
  }

  /* ── ② 关行点穷举 ───────────────────────────────────────────────── */
  const closers = all.filter((m) => /positionStore\.close\(/.test(m.body));
  for (const m of closers) {
    if (!ALLOWED_POSITION_CLOSE.has(m.name)) {
      problems.push(
        `第 ${m.startLine} 行：${m.name} 关掉了本地仓位行，但没有登记 —— 它关的是持仓行还是挂单行？账谁来记？`,
      );
    }
  }
  for (const key of ALLOWED_POSITION_CLOSE.keys()) {
    if (!names.has(key)) problems.push(`登记表 ALLOWED_POSITION_CLOSE 里的 ${key} 已经不存在了 —— 请移除`);
  }

  /* ── ③ "只关挂单"的方法里不许写账（分类必须自洽） ─────────────────── */
  for (const name of PENDING_ONLY) {
    const m = all.find((x) => x.name === name);
    if (m === undefined) continue;
    if (/tradeStore\.insert\(/.test(m.body)) {
      problems.push(
        `第 ${m.startLine} 行：${name} 被登记为"只关挂单"，却写了 trades —— ` +
          '分类错了：要么它关的是真实持仓（那必须走 bookClosedPosition），要么这行账是多余的。',
      );
    }
  }

  /* ── ④ 消失路径必须能走到入账口 ─────────────────────────────────── */
  if (!names.has('bookClosedPosition')) {
    problems.push('找不到 bookClosedPosition() —— 入账口改名/消失，本守卫的判据失效了');
  } else if (!/tradeStore\.insert\(/.test(all.find((m) => m.name === 'bookClosedPosition')!.body)) {
    problems.push('bookClosedPosition() 里没有 tradeStore.insert( —— 入账口不写账了？');
  }
  for (const [from, why] of MUST_REACH_BOOKING) {
    if (!names.has(from)) {
      problems.push(`登记表 MUST_REACH_BOOKING 里的 ${from} 已经不存在了 —— 请移除`);
      continue;
    }
    if (!reaches(code, from, 'bookClosedPosition')) {
      problems.push(`第 ${all.find((m) => m.name === from)!.startLine} 行：${from} 到不了入账口 —— ${why}`);
    }
  }

  /* ── ⑤ 真实通路必须存在（不许被"只在 dryRun 走的路"救活） ───────── */
  for (const [from, why] of REAL_PATH_MUST_REACH_BOOKING) {
    if (!names.has(from)) {
      problems.push(`登记表 REAL_PATH_MUST_REACH_BOOKING 里的 ${from} 已经不存在了 —— 请移除`);
      continue;
    }
    if (!reachesAvoiding(code, from, 'bookClosedPosition', DRY_RUN_ONLY)) {
      problems.push(
        `第 ${all.find((m) => m.name === from)!.startLine} 行：${from} 只有"经过模拟盘结算"的通路能到入账口 —— ${why}`,
      );
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/*  人造变异的文本手术（校准用；只改内存里的字符串，绝不写文件）                  */
/* -------------------------------------------------------------------------- */

/** 在某个方法的**第一行之后**插入一行（模拟"新增一处调用"）。 */
function insertIntoMethod(code: string, methodName: string, snippet: string): string {
  const lines = code.split('\n');
  const m = methodsOf(code).find((x) => x.name === methodName);
  if (m === undefined) return code;
  lines.splice(m.startLine, 0, snippet);
  return lines.join('\n');
}

/** 删掉某个方法体内**含指定片段**的行（模拟"这段代码被删了"）。 */
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

/* -------------------------------------------------------------------------- */
/*  断言                                                                       */
/* -------------------------------------------------------------------------- */

const CODE = stripCommentsKeepLines(RAW);

test('★★★ 每一条"会消失的仓位"路径都必须能走到入账口（静态结构）', () => {
  const all = methodsOf(CODE);
  /* 前置：解析必须真的有效 —— 一个都没解析出来的实现也返回空问题列表（那正是空转）。 */
  assert.ok(all.length >= 90, `★ 只解析出 ${all.length} 个方法 —— 解析失效，本守卫会静默空转`);
  for (const name of ['bookClosedPosition', 'reconcilePositions', 'bookVanishedPosition']) {
    assert.ok(all.some((m) => m.name === name), `★ 找不到 ${name} —— 结构变了，请更新本测试`);
  }

  assert.deepEqual(
    ledgerProblems(CODE),
    [],
    '★★★ 账目不变量被破坏（每一次真实平仓都必须写一行 trades）：\n' +
      ledgerProblems(CODE).map((p) => `      · ${p}`).join('\n') +
      '\n    ⚠️ 历史事故：停机期间被交易所止损平掉的仓位**从账本彻底消失**\n' +
      '      （本仓库记录过实测 +0.2586 vs −0.3136）。\n' +
      '    ✅ 新增平仓路径 → 必须汇入 `bookClosedPosition()`；\n' +
      '       新增写账点 → 必须能说清"为什么不能走入账口"，并登记进 `ALLOWED_TRADE_INSERT`。',
  );
});

test('★★★ 两张登记表与 closeBookingGuard 的必须一致（同一份事实不许两处各写）', () => {
  /*
   * ⚠️ 这条守的是**表本身**：`closeBookingGuard.test.ts` 的 `ALLOWED_CLOSE`
   * 与本文件的 `ALLOWED_POSITION_CLOSE` 必须是同一组方法名。
   * 各写一份会漂移（本仓库为"同一概念两套实现"付过代价），
   * 而漂移的后果是**两份守卫各自放行一半**。
   */
  const other = readFileSync(new URL('./closeBookingGuard.test.ts', import.meta.url), 'utf8');
  const block = /const ALLOWED_CLOSE[\s\S]*?\n\]\);/.exec(other);
  assert.ok(block !== null, '★ 在 closeBookingGuard.test.ts 里找不到 ALLOWED_CLOSE —— 判据失效');
  const names = [...block[0].matchAll(/\n  \[\s*\n?\s*'([a-zA-Z_$][\w$]*)',/g)].map((m) => m[1]!);
  assert.ok(names.length >= 5, `★ 只从 ALLOWED_CLOSE 里抽出 ${names.length} 个方法名 —— 抽取失效`);
  assert.deepEqual(
    [...names].sort(),
    [...ALLOWED_POSITION_CLOSE.keys()].sort(),
    '★★★ 两张关行点登记表不一致 —— 请同时更新两处（它们守的是同一份事实）',
  );
});

test('★★★ 判据必须能真的报出问题 —— 四种人造变异逐一校准', () => {
  /* 基线：真实源码必须无问题（否则下面的"变异后有问题"说明不了判据有效）。 */
  assert.deepEqual(ledgerProblems(CODE), [], '★ 基线就有问题 —— 先修好再看校准');
  const all = methodsOf(CODE);

  /* 变异 A：新增一个未登记的关仓方法（直接关行、不记账）。 */
  const sneakMethod =
    '  private async t43SneakClose(row: { id: number }): Promise<void> {\n' +
    '    positionStore.close(row.id);\n' +
    '  }\n';
  const mutatedA = CODE.replace(
    '  private async bookVanishedPosition(',
    `${sneakMethod}\n  private async bookVanishedPosition(`,
  );
  assert.notEqual(mutatedA, CODE, '★ 变异 A 没有生效（锚点文本变了？）');
  assert.ok(
    ledgerProblems(mutatedA).some((p) => p.includes('t43SneakClose')),
    '★★★ 变异 A（未登记的关仓点）没被报出 —— 第 ② 层判据是空转',
  );

  /* 变异 B：在"只关挂单"的方法里写账（把真实平仓误分类）。 */
  const mutatedB = insertIntoMethod(CODE, 'settlePendingEntries', '    tradeStore.insert({} as never);');
  assert.notEqual(mutatedB, CODE, '★ 变异 B 没有生效');
  assert.ok(
    ledgerProblems(mutatedB).some((p) => p.includes('settlePendingEntries') && p.includes('分类错了')),
    '★★★ 变异 B（只关挂单却写账）没被报出 —— 第 ③ 层判据是空转',
  );

  /* 变异 C：把"仓位消失"到入账口的那一跳删掉（断链）。 */
  const mutatedC = dropLinesWith(CODE, 'bookVanishedPosition', 'await this.bookClosedPosition(');
  assert.notEqual(mutatedC, CODE, '★ 变异 C 没有生效（锚点文本变了？）');
  assert.ok(
    ledgerProblems(mutatedC).some((p) => p.includes('bookVanishedPosition') && p.includes('到不了入账口')),
    '★★★ 变异 C（断掉消失路径）没被报出 —— 第 ④ 层判据是空转（而第 ④ 层是这份守卫的全部价值）',
  );

  /* 变异 D：从新地方写账（绕开入账口）。 */
  const mutatedD = insertIntoMethod(CODE, 'tick', '    tradeStore.insert({} as never);');
  assert.notEqual(mutatedD, CODE, '★ 变异 D 没有生效');
  assert.ok(
    ledgerProblems(mutatedD).some((p) => p.includes('tick') && p.includes('写了 trades，但没有登记')),
    '★★★ 变异 D（未登记的写账点）没被报出 —— 第 ① 层判据是空转',
  );

  /*
   * 变异 E：把"实盘那条消失路径"删掉（`reconcilePositions` 不再调 `bookVanishedPosition`）。
   *
   * ⚠️ 这是**历史事故的原形状**：此时 `reconcilePositions` 仍然"能到达入账口"
   * ——但它只剩模拟盘结算那条通路（`settleDryRunPositions` → `bookClosedPosition`），
   * 而**实盘根本不会走它**。第 ⑤ 层判据就是为这一条存在的。
   */
  const mutatedE = dropLinesWith(CODE, 'reconcilePositions', 'await this.bookVanishedPosition(');
  assert.notEqual(mutatedE, CODE, '★ 变异 E 没有生效（锚点文本变了？）');
  assert.ok(
    ledgerProblems(mutatedE).some((p) => p.includes('reconcilePositions') && p.includes('只有"经过模拟盘结算"的通路')),
    '★★★ 变异 E（实盘消失路径被删、只剩模拟盘通路）没被报出 —— 第 ⑤ 层判据是空转',
  );

  /* 反向：合法输入不许被误报（否则"报出的问题"里全是噪音）。 */
  assert.deepEqual(ledgerProblems(mutatedA).filter((p) => !p.includes('t43SneakClose')), [], '★ 变异 A 之外不该多报');
  assert.equal(all.filter((m) => /tradeStore\.insert\(/.test(m.body)).length, 3, '★ 写账点数量变了 —— 请复核登记表');
});
