/**
 * **风控引擎是通往订单的唯一路径**（`docs/AGENTS.md` §2.1 —— 红线第 1 号）。
 *
 * ## 这条守卫接的是什么
 *
 * §2.1 的原话：
 *
 * > **没有任何代码可以绕过 `packages/server/src/risk/engine.ts` 直接下单。**
 * > `AutoTrader` 只执行 `RiskVerdict.approved` 里的决策。
 * > 不要在风控之外新增任何 `broker.placeOrder()` 调用点（除了 `liveSmokeTest.ts`
 * > 这个人工确认过的测试脚本，以及紧急平仓 `emergencyFlatten`——后者只把仓位变回平坦）。
 *
 * ⚠️ **别的环节都有守卫，唯独"唯一路径"没有**：
 *   · `stopValidBeforeEntry.test.ts` —— 止损必须在开仓前验；
 *   · `orderRecordGuard.test.ts`   —— 每一处下单必须落库；
 *   · `receiptAdjustGate.test.ts`  —— 回执轮改保护位必须先过风控。
 *
 * **"唯一路径"本身没有守卫。** 后果是可实测的：任何人新增一个 `broker.placeOrder()`
 * 调用点（或在别处直接调 `executeOpen`），`typecheck`、全部单测、`lint`
 * **一声都不响** —— 而那是唯一一条"订单可能绕过风控"的路径。
 *
 * ## 判据（三层，全部是"穷举 + 显式登记 + 人造校准"）
 *
 * ① **下单点穷举**：`autoTrader.ts` 里 `broker.placeOrder(` 恰好 7 处，且每一处都落在
 *    **登记过的方法体内**；调用点的载荷必须与登记的性质一致
 *    （`entry` 增加敞口 / `protection` 是 `closePosition` 的保护单 / `reduceOnly` 只减敞口）。
 * ② **调用者穷举**：会下单的方法（`execute*` + `submitLimitEntry` + `placeProtection` +
 *    `emergencyFlatten` + 三个中间层 `replaceProtection`/`flattenAndBook`/`restoreProtection`）
 *    的调用者必须逐一登记在案，并写明它是「approved 消费路径」还是「§2.1 明文的只减敞口例外」。
 * ③ **approved 消费路径**：`for (const decision of verdict.approved)` 的**函数体之内**
 *    必须出现全部 6 个执行分派；两处 `this.risk.review(` 必须各自落在
 *    `runCycleBody` / `followUpAfterExecution` 里；`risk/engine.ts` 不许碰 broker。
 *
 * 外加三条横向守卫：
 *   · **broker 表面被钉住** —— `autoTrader.ts` 用到的适配器方法集合必须与登记表精确相等
 *     （新增一个 `placeOrderXxx` 之类的适配器方法会让它响），且不许把 `broker` 别名/解构；
 *   · **下单端点只有适配器能打**（`/fapi/v1/order` 与 `/fapi/v1/algoOrder` 的 POST 各一处）；
 *   · **恒真断言一律禁止**（见文件末尾 —— 本仓库已有一条这样失效的守卫）。
 *
 * ## 人造校准（为什么这些断言不是空转）
 *
 * 每一条判据都配了一段"人造源码"用例：把同一套判据跑在**故意写坏的代码**上，
 * 断言它必须报错。没有这一层的话，"一条什么都没扫到的实现"同样会全绿 ——
 * 本仓库已经有过一次这样的教训（`trader/agent/perSymbolWiring.test.ts:38` 的
 * 恒真断言让整条用例永远为真，见本文件最后一条测试）。
 *
 * ## 它抓不到什么（诚实说明，别把它当成比它更强的保证）
 *
 * · **不做控制流分析**：把 `this.executeOpen(` 留在**同一个已登记的方法体里**、
 *   但用一个新的条件分支（`if (某条件) { … }`）绕开 approved 循环 —— 抓不到。
 *   本守卫防的是"**新增/挪动调用点**"，不是"篡改已有分支的条件"。
 * · **不做类型/绑定分析**：它读的是源码文本（`plainCode()` 把注释/字符串/正则抹成空格后）。
 *   通过 `import` 拿一个 `AutoTrader` 实例、再用 `as any` 调私有方法**不会**被这里挡住
 *   —— 但会被"跨文件调用"那条与 TypeScript 的 `private` 一起挡住。
 * · 模板字面量里的 `${…}` 插值也一并被抹掉了 —— 所以"在模板字符串里调用下单方法"
 *   这种形态（今天不存在，也没有正当理由）看不见。
 * · 动态字符串调用（`this['execute' + 'Open']`）无法穷举 —— 所以额外**禁止**
 *   `this[` 这种括号取成员形式出现在 `autoTrader.ts` 里（当前实测 0 处）。
 * · 它不证明"approved 数组里的决策真的过了 `review()`" ——
 *   那是 `risk/engine.test.ts` 与 `receiptAdjustGate.test.ts` 的事。
 * · 它不覆盖 `binance/broker.ts` **内部**新增的下单逻辑（只覆盖"谁能打下单端点"）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/* -------------------------------------------------------------------------- */
/*  读源码（注释/字符串/正则抹成空格，**行号与文件一致**）                       */
/* -------------------------------------------------------------------------- */

/**
 * 一个 `/` 是否**开始一个正则字面量**（而不是除法）。
 *
 * 判据沿用通行的启发式：往前看第一个非空白字符 —— 它是运算符/开括号/逗号/分号，
 * 或者不存在（文件/表达式开头）时，这个 `/` 是正则；是标识符或 `)` `]` 时是除法。
 *
 * ## 为什么需要它（实测踩到）
 *
 * `strategy/teamStyle.test.ts:94` 的断言里有一个**内含单引号的正则**
 * （`/'交易模式：…/`）。把它当字符串扫描会让引号配对整体错位，
 * 后续的文本被吞进"字符串"，`assert` 实参从此不配平 ——
 * 守卫自己抛错（"从位置 571 开始的 ( 没有闭合"）。
 */
const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*/%<>~^]/;

function isRegexStart(text: string, slashIndex: number): boolean {
  for (let i = slashIndex - 1; i >= 0; i -= 1) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    return REGEX_PRECEDER.test(ch);
  }
  return true;
}

/** 跳过 `i` 处的一个字符串 / 模板 / 正则字面量，返回它之后的下标。 */
function skipLiteral(text: string, i: number): number {
  const ch = text[i] as string;
  if (ch === "'" || ch === '"' || ch === '`') {
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === '\\') {
        j += 1;
        continue;
      }
      if (text[j] === ch) return j + 1;
    }
    return text.length;
  }
  /* 正则：**不跨行**，所以要挡掉 `a / b`（除法）误吞后面整段的情况。 */
  let inClass = false;
  for (let j = i + 1; j < text.length; j += 1) {
    const c = text[j] as string;
    if (c === '\\') {
      j += 1;
      continue;
    }
    if (c === '\n') return j;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
  }
  return text.length;
}

/**
 * **把"非代码"的部分抹成空格**：注释、字符串内容、正则表达式内容。
 *
 * ## 为什么不能直接用 `codeOnly()`（实测踩到）
 *
 * `codeOnly()` 是**按行**丢注释的，而本仓库大量提示词是**多行模板字面量**，
 * 里面常有一行以 `*` 开头（markdown 列表）。按行丢会把模板里的内容一起丢掉 ——
 * 实测后果：`assert` 实参里的一个 `)` 被吃掉，`assert.ok(` 从此不配平。
 * 而且它是**按行删除**的，行号会整体前移（实测偏差 5000 行）。
 *
 * ⚠️ 本函数是**长度保持**的（被抹的内容→空格、换行保留），所以行号就是文件行号。
 *
 * @param keepStrings 保留字符串**内容**（默认抹掉）。
 *   ⚠️ 需要按"字面量"查东西时（例如找 `'/fapi/v1/order'` 这个端点名）必须传 `true` ——
 *   字符串内容被抹掉之后，那种查询会**一条都查不到**，于是守卫静默失效
 *   （实测：端点守卫因此把 0 当成了"没有越权调用"）。而查"代码形状"时
 *   （`reduceOnly: true`、`for (const …)`）要默认抹掉，否则报错文案里的示例会被当成真代码。
 */
function plainCode(text: string, keepStrings = false): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '/' && text[i + 1] === '*') {
      let j = i;
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) {
        out += text[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      out += '  ';
      i = j + 2;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '/' && isRegexStart(text, i))) {
      const end = skipLiteral(text, i);
      if (keepStrings && ch !== '/') {
        out += text.slice(i, end);
        i = end;
        continue;
      }
      /* 保留首尾两个字符（引号或斜杠），中间抹成空格。 */
      out += ch + ' '.repeat(Math.max(0, end - i - 2)) + (end > i ? (text[end - 1] ?? '') : '');
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const AUTO_TRADER_RAW = readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8');
/**
 * ⚠️ **不能用 `codeOnly()`**：它是"按行**删除**注释行"，于是行号会整体前移 ——
 * 报错信息里的"第 N 行"会指向一段完全无关的代码（实测偏差 5000 行）。
 * 本文件统一用 `plainCode()`（长度保持），所以下面报出来的行号**就是文件里的行号**。
 *
 * `plainCode()` 定义在下方（函数声明会提升），复用同一份实现。
 */
const AUTO_TRADER = plainCode(AUTO_TRADER_RAW);

/** `packages/server/src` 的绝对路径（从本文件往上找，不依赖 cwd）。 */
const SERVER_SRC = (() => {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (statSync(join(dir, 'trader', 'autoTrader.ts')).isFile()) return dir;
    } catch {
      /* 继续往上。 */
    }
    dir = join(dir, '..');
  }
  throw new Error('找不到 packages/server/src —— 扫描的基准目录取不到，守卫无法工作');
})();

/* -------------------------------------------------------------------------- */
/*  基础工具（纯函数，逐条有人造校准）                                          */
/* -------------------------------------------------------------------------- */

interface Member {
  name: string;
  /** 1-based 起始行。 */
  startLine: number;
  /** 1-based 结束行（含）。 */
  endLine: number;
  body: string;
}

/**
 * 取出类里**方法级**的成员（用"缩进两格的声明"当边界）。
 *
 * 与 `orderRecordGuard.test.ts` 同一手法 —— 两个守卫的解析口径一致，
 * 换一个人读的时候不用学第二套规则。
 */
function membersOf(code: string): Member[] {
  const lines = code.split('\n');
  const out: Member[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([a-zA-Z_$][\w$]*)\s*[(<]/.exec(
      lines[i] ?? '',
    );
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      if (/^ {2}(?:private |public |protected |static |async |readonly )*[a-zA-Z_$][\w$]*\s*[(<]/.test(line)) {
        end = j;
        break;
      }
      if (/^\}/.test(line)) {
        end = j;
        break;
      }
    }
    out.push({
      name: m[1]!,
      startLine: i + 1,
      endLine: end,
      body: lines.slice(i, end).join('\n'),
    });
  }
  return out;
}

/** 某个 1-based 行号落在哪个方法体里（不在任何方法体内时返回 `null`）。 */
function enclosingMember(members: readonly Member[], line: number): string | null {
  for (const member of members) {
    if (line >= member.startLine && line <= member.endLine) return member.name;
  }
  return null;
}

/**
 * 从 `startIndex` 处的开括号取出一段**配平**的文本（跳过字符串与行注释）。
 *
 * ⚠️ 取不到闭合就**抛错**，不返回空串 —— 一个"扫描失败但静默通过"的守卫
 * 正是这个文件存在的理由。
 */
function balancedFrom(text: string, startIndex: number): string {
  const open = text[startIndex];
  if (open !== '{' && open !== '(' && open !== '[') {
    throw new Error(`balancedFrom 的起点不是括号（位置 ${startIndex}）—— 扫描失效`);
  }
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  let quote: string | null = null;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  throw new Error(`从位置 ${startIndex} 开始的 ${open} 没有闭合 —— 源码被改了形状，守卫必须报错而不是沉默`);
}

interface CallSite {
  /** 1-based 行号。 */
  line: number;
  /** 调用的实参块（配平，含括号）。 */
  args: string;
  /** 包含它的方法名（取不到时为 `null`）。 */
  inMember: string | null;
}

/**
 * 找出代码里所有 `this.<name>(` 的调用点。
 *
 * ⚠️ **空白容忍**（`this.deps.broker\n  .placeOrder(` 这种折行在 `autoTrader.ts` 里真实存在，
 * 实测 3 处）：用字面 `indexOf` 去找会**漏掉折行的调用点** —— 而"漏掉"在这里
 * 正是最坏的失效形态（守卫静默通过）。
 */
function callSitesOf(code: string, name: string, members: readonly Member[]): CallSite[] {
  const out: CallSite[] = [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`this\\s*\\.\\s*${escaped}\\s*\\(`, 'g');
  for (const m of code.matchAll(re)) {
    const at = (m.index ?? 0) + m[0].length - 1;
    const line = code.slice(0, m.index ?? 0).split('\n').length;
    out.push({
      line,
      args: balancedFrom(code, at),
      inMember: enclosingMember(members, line),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  登记表（每一条都要写明理由 —— 后来人加东西时必须面对这张表）                  */
/* -------------------------------------------------------------------------- */

type OrderKind = 'entry' | 'protection' | 'reduceOnly';

/**
 * `autoTrader.ts` 里**每一处** `broker.placeOrder(` 的登记。
 *
 * 顺序与文件里的出现顺序一致（平仓 → 限价入场 → 市价开仓 → 保护单 → 加仓 → 减仓 → 紧急平仓）。
 */
const PLACE_ORDER_SITES: ReadonlyArray<{ member: string; kind: OrderKind; why: string }> = [
  { member: 'executeClose', kind: 'reduceOnly', why: '平仓：`reduceOnly: true`（只减敞口）' },
  { member: 'submitLimitEntry', kind: 'entry', why: '限价入场挂单：只从 `executeOpen` 到达（那份决策已过风控）' },
  { member: 'executeOpen', kind: 'entry', why: '市价开仓：只从 `verdict.approved` 的消费循环到达' },
  { member: 'placeProtection', kind: 'protection', why: '止损/止盈：`closePosition: true`，只为已有仓位挂保护' },
  { member: 'executeAdd', kind: 'entry', why: '加仓：只从 `verdict.approved` 到达（`reviewAdd` 用的是 `reviewOpen` 全量判据）' },
  { member: 'executeReduce', kind: 'reduceOnly', why: '部分减仓：`reduceOnly: true`' },
  { member: 'emergencyFlatten', kind: 'reduceOnly', why: '紧急全平：`reduceOnly: true` —— §2.1 明文例外' },
];

/**
 * 会下单（或直接通往下单）的方法 → 允许的调用者。
 *
 * **每一条都要说清它是哪一类**：
 *   · 「approved」= 在 `verdict.approved` / `adjustVerdict.approved` 的消费循环里；
 *   · 「减敞口」  = §2.1 明文例外（只把仓位变小/变平，或只为已有仓位挂保护）。
 */
const CALLERS: ReadonlyArray<{
  callee: string;
  /** 必须真的存在这些调用者（防止"调用图为空"也能通过 ⊆ 判定）。 */
  required: readonly string[];
  allowed: ReadonlyArray<{ caller: string; why: string }>;
}> = [
  {
    callee: 'executeOpen',
    required: ['runCycleBody'],
    allowed: [
      { caller: 'runCycleBody', why: 'approved：`for (const decision of verdict.approved)` 的分派' },
      { caller: 'submitLimitEntry', why: 'approved：限价单会立即成交时退回市价 —— 同一份已批准的决策' },
    ],
  },
  {
    callee: 'executeClose',
    required: ['runCycleBody'],
    allowed: [
      { caller: 'runCycleBody', why: 'approved：分派 `close_long` / `close_short`' },
      { caller: 'applyDrawdownGuard', why: '减敞口：机械回撤守卫平仓（§2.9，不问模型）' },
      { caller: 'closeManually', why: '减敞口：操作员手工平仓（API `/positions/:symbol/close`）' },
    ],
  },
  {
    callee: 'executeAdd',
    required: ['runCycleBody'],
    allowed: [{ caller: 'runCycleBody', why: 'approved：分派 `add_to_position`' }],
  },
  {
    callee: 'executeReduce',
    required: ['runCycleBody'],
    allowed: [{ caller: 'runCycleBody', why: 'approved：分派 `reduce_position`' }],
  },
  {
    callee: 'executeAdjust',
    required: ['runCycleBody', 'followUpAfterExecution'],
    allowed: [
      { caller: 'runCycleBody', why: 'approved：分派 `adjust_protection`' },
      {
        caller: 'followUpAfterExecution',
        why: 'approved：执行回执轮走 `adjustVerdict.approved`（外部 issue #117 已把这处接上风控）',
      },
    ],
  },
  {
    callee: 'submitLimitEntry',
    required: ['executeOpen'],
    allowed: [{ caller: 'executeOpen', why: 'approved：`entry_type === "limit"` 时走这条路' }],
  },
  {
    callee: 'placeProtection',
    required: ['executeOpen', 'replaceProtection'],
    allowed: [
      { caller: 'executeOpen', why: '§2.6：开仓后立刻挂止损/止盈（`closePosition`，不增加敞口）' },
      { caller: 'promotePendingEntry', why: '§2.6：限价成交转正后立刻补挂' },
      { caller: 'executeAdjust', why: 'approved：调保护位（`reviewAdjust` 有方向棘轮校验）' },
      { caller: 'replaceProtection', why: '加/减仓与对账补挂：按新数量重挂保护' },
      { caller: 'applyBreakevenGuard', why: '减敞口：保本止损只把止损往有利方向移' },
    ],
  },
  {
    callee: 'emergencyFlatten',
    required: ['executeOpen'],
    allowed: [
      { caller: 'executeOpen', why: '§2.6：止损挂不上 → 立刻市价平仓' },
      { caller: 'flattenAndBook', why: '§2.6：无保护敞口 → 平仓并记账' },
      { caller: 'executeAdjust', why: '§2.6：调整后没有有效止损 → 立刻平仓' },
      { caller: 'applyBreakevenGuard', why: '§2.6：撤旧成功、挂新失败 → 不留无保护敞口' },
      { caller: 'closeManually', why: '减敞口：操作员手工平仓' },
    ],
  },
  /* --- 下面三个是"通往下单的中间层"：漏了它们，新增一个调用者就等于新增一条下单路径 --- */
  {
    callee: 'replaceProtection',
    required: ['executeAdd', 'executeReduce', 'ensureStopsOnOpenPositions'],
    allowed: [
      { caller: 'reconcilePositions', why: '对账收养外部持仓后补挂兜底止损' },
      { caller: 'ensureStopsOnOpenPositions', why: '§2.6：交易所侧缺止损时补挂' },
      { caller: 'executeAdd', why: 'approved：加仓后按新数量重挂' },
      { caller: 'executeReduce', why: 'approved：减仓后按剩余数量重挂' },
      { caller: 'restoreProtection', why: '撤单后下单失败的恢复路径' },
    ],
  },
  {
    callee: 'flattenAndBook',
    required: ['executeAdd', 'executeReduce'],
    allowed: [
      { caller: 'promotePendingEntry', why: '§2.6：限价成交后保护挂不上 → 平掉' },
      { caller: 'executeAdd', why: '§2.6：加仓后保护挂不上 → 平掉整个仓位' },
      { caller: 'executeReduce', why: '§2.6：减仓后剩余部分保护挂不上 → 平掉剩余' },
    ],
  },
  {
    callee: 'restoreProtection',
    required: ['executeAdd', 'executeReduce'],
    allowed: [
      { caller: 'executeAdd', why: '加仓下单失败/未成交 → 恢复原有保护' },
      { caller: 'executeReduce', why: '减仓下单失败/未成交 → 恢复原有保护' },
    ],
  },
];

/**
 * 与"增加敞口"有关的方法（它们的 `placeOrder` 载荷既不是 `reduceOnly` 也不是 `closePosition`）。
 *
 * ⚠️ **这是红线最锋利的一句话**：这三条路径的**唯一**外部入口必须是
 * approved 循环（或它内部已批准的连带分支）。
 */
const EXPOSURE_MEMBERS = new Set(['executeOpen', 'submitLimitEntry', 'executeAdd']);

/* -------------------------------------------------------------------------- */
/*  判据实现（与断言共用同一份实现 —— 人造校准跑的必须是生产判据）                */
/* -------------------------------------------------------------------------- */

const MEMBERS = membersOf(AUTO_TRADER);

interface SiteFinding {
  line: number;
  member: string | null;
  kind: OrderKind;
  /** 登记表怎么说；未登记时为 `null`。 */
  registered: OrderKind | null;
}

/** 把一处 `placeOrder(` 的实参块判成 entry / protection / reduceOnly。 */
function kindOfPayload(args: string): OrderKind {
  if (/closePosition:\s*true/.test(args)) return 'protection';
  if (/reduceOnly:\s*true/.test(args)) return 'reduceOnly';
  return 'entry';
}

/**
 * 扫描一份源码里的全部下单点与它们的登记情况。
 *
 * ⚠️ 用**空白容忍**的正则而不是字面 `indexOf`：`this.deps.broker\n  .placeOrder(` 这种
 * 折行写法在本仓库真实存在（实测 3 处别的 broker 调用就是折行的），
 * 字面查找会**漏掉**它 —— 而"漏掉一个下单点"正是这条守卫最不能出的错。
 */
function scanOrderSites(code: string, members: readonly Member[], sites: typeof PLACE_ORDER_SITES): SiteFinding[] {
  const out: SiteFinding[] = [];
  const re = /this\s*\.\s*deps\s*\.\s*broker\s*\.\s*placeOrder\s*\(/g;
  for (const m of code.matchAll(re)) {
    const at = (m.index ?? 0) + m[0].length - 1;
    const line = code.slice(0, m.index ?? 0).split('\n').length;
    const member = enclosingMember(members, line);
    const args = balancedFrom(code, at);
    const kind = kindOfPayload(args);
    const registered = sites.find((s) => s.member === member)?.kind ?? null;
    out.push({ line, member, kind, registered });
  }
  return out;
}

/** 未登记的下单点，或载荷与登记性质不一致的下单点。 */
function orderSiteProblems(findings: readonly SiteFinding[]): string[] {
  const problems: string[] = [];
  for (const f of findings) {
    if (f.registered === null) {
      problems.push(`第 ${f.line} 行：` + `${f.member ?? '（不在任何方法体内）'} 里的 broker.placeOrder(` + ` 没有登记`);
      continue;
    }
    if (f.registered !== f.kind) {
      problems.push(
        `第 ${f.line} 行：${f.member} 的下单载荷被判成「${f.kind}」，` +
          `而登记表写的是「${f.registered}」—— 性质变了就必须面对登记表`,
      );
    }
  }
  return problems;
}

/** 调用者不在白名单里的调用点。 */
function callerProblems(
  code: string,
  members: readonly Member[],
  table: typeof CALLERS,
): { offenders: string[]; actual: Map<string, Set<string | null>> } {
  const offenders: string[] = [];
  const actual = new Map<string, Set<string | null>>();
  for (const entry of table) {
    const sites = callSitesOf(code, entry.callee, members);
    const callers = new Set(sites.map((s) => s.inMember));
    actual.set(entry.callee, callers);
    const allowedNames = new Set(entry.allowed.map((a) => a.caller));
    for (const site of sites) {
      if (site.inMember !== null && allowedNames.has(site.inMember)) continue;
      const why = entry.allowed.map((a) => `      · 允许：${a.caller} —— ${a.why}`).join('\n');
      offenders.push(
        `第 ${site.line} 行：${site.inMember ?? '（不在任何方法体内）'} 调用了 ${entry.callee}(` +
          `\n    这张表里允许的调用者：\n${why}`,
      );
    }
    for (const required of entry.required) {
      if (!callers.has(required)) {
        offenders.push(
          `${entry.callee} 缺少登记的调用者「${required}」—— 调用图被改过了（或扫描失效）。` +
            `\n    这张表要求它必须存在，否则"⊆ 白名单"会因为调用图空了而恒真。`,
        );
      }
    }
  }
  return { offenders, actual };
}

/* -------------------------------------------------------------------------- */
/*  ① 下单点穷举：7 处，全在登记的方法体内，载荷性质一致                          */
/* -------------------------------------------------------------------------- */

test('★★★ 红线上游：broker.placeOrder 只能出现在登记的 7 个方法体里，载荷性质不许变', () => {
  /* 前置断言：解析真的拿到方法了（否则"零个问题"是因为没解析到东西）。 */
  assert.ok(MEMBERS.length >= 20, `★ 只解析出 ${MEMBERS.length} 个方法 —— 解析可能失效了`);

  const sites = scanOrderSites(AUTO_TRADER, MEMBERS, PLACE_ORDER_SITES);

  assert.deepEqual(
    sites.map((s) => s.member),
    PLACE_ORDER_SITES.map((s) => s.member),
    '★★★ `broker.placeOrder(` 的调用点集合与登记表不一致。\n' +
      '    AGENTS.md §2.1：**不要在风控之外新增任何 `broker.placeOrder()` 调用点**。\n' +
      '    真的需要新增时：先确认它只**减少**敞口，再把它加进 `PLACE_ORDER_SITES` 并写明理由。\n' +
      `    实际扫描到：${sites.map((s) => `${s.member ?? '?'}@${s.line}`).join('、') || '（一个都没有 —— 扫描失效）'}`,
  );

  const problems = orderSiteProblems(sites);
  assert.deepEqual(
    problems,
    [],
    '★★★ 有下单点未登记 / 载荷性质与登记不符：\n' +
      problems.map((p) => `      · ${p}`).join('\n') +
      '\n    `entry` 会增加敞口（必须过风控）；`reduceOnly` 只减敞口；' +
      '`closePosition` 是条件单，只为已有仓位挂保护。',
  );
});

/* -------------------------------------------------------------------------- */
/*  ② 调用者穷举：approved 消费路径 或 §2.1 明文例外                            */
/* -------------------------------------------------------------------------- */

test('★★★ 红线中游：会下单的方法只能从 approved 消费路径 / §2.1 只减敞口例外到达', () => {
  const { offenders, actual } = callerProblems(AUTO_TRADER, MEMBERS, CALLERS);

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些下单路径多了一个没登记的调用者：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    §2.1：「**没有任何代码可以绕过 `risk/engine.ts` 直接下单**」。\n' +
      '    新路径只有两种合法归属：\n' +
      '      ① 在 `verdict.approved` / `adjustVerdict.approved` 的消费循环里（过了风控）；\n' +
      '      ② 只 **减少** 敞口（平仓/减仓/撤单/挂保护单）—— 那也要在 `CALLERS` 里写明理由。\n' +
      '    ✅ 若它不满足上面两条：**这就是一个绕过风控的下单路径**，不要改这张表。',
  );

  /* ⚠️ 非空性：调用图为空时 ⊆ 判定会恒真，所以逐条要求"必需的调用者"确实存在。 */
  assert.ok(actual.size === CALLERS.length, '★ 调用者扫描没有覆盖全部登记项 —— 守卫在空转');
});

test('★★★ 红线最锋利的一句：增加敞口的下单，唯一外部入口是 approved 循环', () => {
  const exposure = CALLERS.filter((c) => EXPOSURE_MEMBERS.has(c.callee));
  assert.equal(
    exposure.length,
    EXPOSURE_MEMBERS.size,
    '★ 登记表里"会增加敞口"的方法数量与 EXPOSURE_MEMBERS 不一致 —— 名单被改过了',
  );

  const problems: string[] = [];
  for (const entry of exposure) {
    /* 允许的外部入口：approved 循环、或它内部已批准的连带分支。 */
    const APPROVED_ONLY = new Set(['runCycleBody', 'executeOpen', 'submitLimitEntry']);
    for (const { caller, why } of entry.allowed) {
      if (!APPROVED_ONLY.has(caller)) problems.push(`${entry.callee} 登记了非 approved 的调用者 ${caller}（${why}）`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    '★★★ 增加敞口的路径出现了"只减敞口"的调用者 —— 那是自相矛盾的登记：\n' +
      problems.map((p) => `      · ${p}`).join('\n'),
  );
});

/* -------------------------------------------------------------------------- */
/*  ③ approved 消费路径：分派必须在循环体内，风控必须先于执行                     */
/* -------------------------------------------------------------------------- */

test('★★★ 红线下游：6 个执行分派必须都在 `for (const decision of verdict.approved)` 的循环体内', () => {
  const LOOP_NEEDLE = 'for (const decision of verdict.approved) {';
  const loopAt = AUTO_TRADER.indexOf(LOOP_NEEDLE);
  assert.ok(
    loopAt > 0,
    '★★★ 找不到 `for (const decision of verdict.approved) {` —— ' +
      '§2.1 要求 `AutoTrader` **只执行 `RiskVerdict.approved` 里的决策**，这个循环是那句话的实现。',
  );
  assert.equal(
    AUTO_TRADER.split(LOOP_NEEDLE).length - 1,
    1,
    '★ 这个循环出现了不止一次 —— 执行路径必须只有一个（多出来的那一处要单独审）',
  );

  const loopBody = balancedFrom(AUTO_TRADER, loopAt + LOOP_NEEDLE.length - 1);
  const mustBeInside = [
    'this.executeCancelPending(',
    'this.executeClose(',
    'this.executeAdjust(',
    'this.executeAdd(',
    'this.executeReduce(',
    'this.executeOpen(',
  ];
  const missing = mustBeInside.filter((needle) => !loopBody.includes(needle));
  assert.deepEqual(
    missing,
    [],
    '★★★ 这些执行分派**不在** approved 循环体内了：\n' +
      missing.map((m) => `      · ${m}`).join('\n') +
      '\n    把它们移出这个循环 = 让一条没有经过风控裁决的决策走到下单。',
  );
});

test('★★★ 风控裁决必须先于执行，且两处 `risk.review(` 只允许在 runCycleBody / followUpAfterExecution 里', () => {
  const sites = callSitesOf(AUTO_TRADER, 'risk.review', MEMBERS);
  assert.equal(
    sites.length,
    2,
    `★ 全文件应该有且只有 2 处 \`this.risk.review(\`（主路径 + 执行回执），实际 ${sites.length} 处。\n` +
      '    多出来的一处要单独审：它可能是一条新的、没被登记的下单路径。',
  );

  assert.deepEqual(
    sites.map((s) => s.inMember).sort(),
    ['followUpAfterExecution', 'runCycleBody'],
    '★★★ `risk.review(` 出现在意料之外的方法里 —— 那意味着有一条新的调用链在用它（或者漏掉了某条）',
  );

  const reviewAt = AUTO_TRADER.indexOf('this.risk.review(');
  const loopAt = AUTO_TRADER.indexOf('for (const decision of verdict.approved) {');
  assert.ok(reviewAt > 0 && loopAt > 0, '★ 找不到风控调用或 approved 循环 —— 扫描失效');
  assert.ok(
    reviewAt < loopAt,
    '★★★ 主路径的 `this.risk.review(` 排在 approved 消费循环**之后** —— ' +
      '先执行再审查等于没有审查',
  );

  /* 回执轮那一条：`adjustVerdict.approved` 必须真的被消费。 */
  assert.ok(
    /for \(const decision of adjustVerdict\.approved\)/.test(AUTO_TRADER),
    '★★★ 回执轮不再消费 `adjustVerdict.approved` —— ' +
      '外部 issue #117 的修复正是"回执里的 adjust 必须先过 risk.review"，这条断言钉住它',
  );

  /* 禁用括号取成员：动态字符串调用无法穷举，所以直接把这种形状禁掉。 */
  assert.equal(
    (AUTO_TRADER.match(/this\[/g) ?? []).length,
    0,
    '★★★ `autoTrader.ts` 里出现了 `this[` —— 动态成员调用会绕过上面全部静态扫描。\n' +
      '    若确有正当理由（例如遍历一堆同名方法），请在本守卫里显式登记并说明它为什么到不了下单。',
  );
});

test('★★★ 风控引擎自身不许碰 broker —— 它是纯裁决者', () => {
  const engine = plainCode(readFileSync(join(SERVER_SRC, 'risk', 'engine.ts'), 'utf8'));
  const violations: string[] = [];
  if (/\bplaceOrder\b/.test(engine)) violations.push('出现了 placeOrder');
  if (/\bcancelOrder\b/.test(engine)) violations.push('出现了 cancelOrder');
  if (/from '.*binance\//.test(engine)) violations.push('直接 import 了 binance/ 的实现');
  assert.deepEqual(
    violations,
    [],
    '★★★ `risk/engine.ts` 不该有下单/撤单能力（它只拿事实评判提案）：\n' +
      violations.map((v) => `      · ${v}`).join('\n'),
  );
});

/* -------------------------------------------------------------------------- */
/*  ④ 跨文件：别处不许直接调这些执行方法                                        */
/* -------------------------------------------------------------------------- */

test('★★★ 别处不许直接调 `execute*` / `placeProtection` / `emergencyFlatten`（只能在 autoTrader.ts 内）', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.ts$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };

  const needles = [
    'executeOpen',
    'executeClose',
    'executeAdd',
    'executeReduce',
    'executeAdjust',
    'submitLimitEntry',
    'placeProtection',
    'emergencyFlatten',
    'flattenAndBook',
  ];
  const re = new RegExp(`\\.(${needles.join('|')})\\(`);

  const offenders: string[] = [];
  for (const file of walk(SERVER_SRC)) {
    const rel = file.slice(SERVER_SRC.length + 1).replace(/\\/g, '/');
    if (rel === 'trader/autoTrader.ts') continue;
    const code = plainCode(readFileSync(file, 'utf8'));
    if (re.test(code)) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些文件在直接调用执行类方法：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    下单只能从 `AutoTrader` 内部、经 approved 消费路径发起（TypeScript 的 `private` 是第一道，' +
      '这里是第二道 —— 防的是 `as any` 与将来把方法改成 public）。',
  );
});

/* -------------------------------------------------------------------------- */
/*  ④.5 broker 表面：整个方法集合被登记（新增一个适配器方法也要面对这张表）        */
/* -------------------------------------------------------------------------- */

/**
 * `autoTrader.ts` 允许使用的 broker 方法 —— **新增一个就必须面对这张表**。
 *
 * ## 为什么连"读"的方法也要登记
 *
 * 上面第 ① 条判据数的是 `placeOrder`。若将来有人加一个
 * `broker.placeOrderReduceOnly(...)` / `broker.placeBatch(...)` 之类的新方法，
 * **那条判据不会变**（它只认 `placeOrder` 这个名字），于是新的下单面悄悄出现。
 * 把整张 broker 表面钉住之后，任何新的适配器方法调用都会让这条测试响 ——
 * 加它的人必须来这里写一句"它会不会下单"。
 */
const BROKER_METHODS: ReadonlyArray<{ name: string; why: string }> = [
  { name: 'placeOrder', why: '唯一的真实下单入口（7 处，见 `PLACE_ORDER_SITES`）' },
  { name: 'cancelAllOrders', why: '撤该标的全部挂单（平仓/加仓/减仓/调保护前，§2.7）' },
  { name: 'cancelOrder', why: '撤单张（保本守卫、待成交对账、过期挂单）' },
  { name: 'setLeverage', why: '开仓前设杠杆（输入是已批准的 `decision.leverage`）' },
  { name: 'setMarginType', why: '开仓前设逐仓/全仓（配置决定）' },
  { name: 'ensureOneWayMode', why: '检查持仓模式（双向模式下整个机器人停止下单）' },
  { name: 'getAccountState', why: '账户权益/可用余额' },
  { name: 'getPositions', why: '交易所持仓（对账的真相来源）' },
  { name: 'getOpenOrders', why: '普通挂单列表' },
  { name: 'getOpenAlgoOrders', why: '条件单列表（判断止损还在不在）' },
  { name: 'getOrder', why: '单张普通订单（撤单失败时判断"成了还是没了"）' },
  { name: 'getAlgoOrder', why: '单张条件单（限价入场结算）' },
  { name: 'getUserTrades', why: '成交明细（手续费、出场价）' },
  { name: 'getIncome', why: '资金费流水' },
  { name: 'getMarkPrice', why: '标记价（止损侧校验、兜底换算）' },
  { name: 'getMaxLeverage', why: '交易所允许的杠杆上限（预热缓存）' },
  { name: 'waitForFill', why: '轮询到终态（只看交易所报的事实）' },
];

test('★★★ broker 表面被钉住：新增任何适配器方法调用都必须先来这里登记', () => {
  const re = /this\s*\.\s*deps\s*\.\s*broker\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  const used = new Set<string>();
  for (const m of AUTO_TRADER.matchAll(re)) used.add(m[1]!);

  assert.deepEqual(
    [...used].sort(),
    BROKER_METHODS.map((m) => m.name).sort(),
    '★★★ `autoTrader.ts` 用到的 broker 方法集合与登记表不一致。\n' +
      `    实际用到：${[...used].sort().join('、')}\n` +
      '    ⚠️ 新增一个适配器方法调用，就是新增一块"能碰到交易所"的表面 —— ' +
      '先确认它会不会下单，再来这张表里写明理由。',
  );
  /* 非空性：这条守卫必须真的看到那个下单方法，否则集合相等可以是两个空集的巧合。 */
  assert.ok(used.has('placeOrder'), '★★ `placeOrder` 不在实际集合里 —— 扫描口径失效了');

  /*
   * ⚠️ **别名 / 解构会让上面所有按名字的扫描一起失效**：
   *     const b = this.deps.broker;   b.placeOrder(…)
   * 这种写法下，"`this.deps.broker.placeOrder(` 出现几次"这个判据永远看不见它。
   * 所以这里直接把这种形状禁掉。
   */
  /*
   * ⚠️ **`(?!\s*\.)` 而不是 `(?!\.)`** —— 实测踩到：`this.deps.broker\s*(?!\.)`
   * 会在折行的链式调用（`const live = await this.deps.broker\n  .getOrder(…)`）上
   * **回溯成功**（`\s*` 少吃掉一个空格，后面就不是 `.` 了），于是把本仓库真实存在的
   * 3 处链式调用误判成"别名"。判据必须把"中间可以有空白"一起否掉。
   */
  const ALIAS_PATTERNS = [
    /(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?this\.deps\.broker(?!\s*\.)/,
    /}\s*=\s*this\.deps\.broker(?!\s*\.)/,
  ];
  assert.deepEqual(
    ALIAS_PATTERNS.filter((r) => r.test(AUTO_TRADER)).map((r) => String(r)),
    [],
    '★★★ `this.deps.broker` 被存进了变量（别名/解构）——\n' +
      '    那样本守卫按 `this.deps.broker.<方法>(` 的扫描会全部失效（看不见真正的调用点）。\n' +
      '    ✅ 修法：直接写 `this.deps.broker.xxx(…)`，或先来这里登记一个"别名也扫描"的实现。',
  );

  /* 校准：别名判据必须能报出人造的别名，且不误报折行的链式调用（本仓库真实存在 3 处）。 */
  assert.ok(
    ALIAS_PATTERNS.some((r) => r.test('const b = this.deps.broker;')),
    '★★★ 校准失败：人造的别名语句没被报出来 —— 上面那条是空转',
  );
  assert.ok(
    !ALIAS_PATTERNS.some((r) => r.test('const live = await this.deps.broker\n  .getOrder(s, id);')),
    '★★ 折行的链式调用（`this.deps.broker\\n  .getOrder(…)`）不该被误判成别名',
  );
});

/* -------------------------------------------------------------------------- */
/*  ⑤ 下单端点：只有适配器能打                                                  */
/* -------------------------------------------------------------------------- */

test('★★★ 下单 HTTP 端点只有 binance/broker.ts 能打，且下单请求恰好两条', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.ts$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };

  const ORDER_ENDPOINTS = '(?:order|algoOrder|allOpenOrders|algoOpenOrders)';
  const re = new RegExp(
    `signedRequest(?:<[^>]*>)?\\(\\s*['"](?:POST|DELETE|PUT)['"]\\s*,\\s*['"]/fapi/v1/${ORDER_ENDPOINTS}['"]`,
  );

  const offenders: string[] = [];
  let postOrder = 0;
  let postAlgo = 0;
  for (const file of walk(SERVER_SRC)) {
    const rel = file.slice(SERVER_SRC.length + 1).replace(/\\/g, '/');
    /*
     * ⚠️ `keepStrings = true`：这条守卫查的是**端点名字面量**（`'/fapi/v1/order'`），
     * 而 `plainCode` 默认会把字符串内容抹掉 —— 那样这里会一条都查不到，
     * 表现为"零个越权调用"（实测踩到：计数从 1 变成 0）。
     */
    const code = plainCode(readFileSync(file, 'utf8'), true);
    const hits = code.match(re) ?? [];
    if (hits.length === 0) continue;
    if (rel !== 'binance/broker.ts') offenders.push(`${rel}（${hits.length} 处）`);
    postOrder += (code.match(/signedRequest(?:<[^>]*>)?\(\s*'POST'\s*,\s*'\/fapi\/v1\/order'/g) ?? []).length;
    postAlgo += (code.match(/signedRequest(?:<[^>]*>)?\(\s*'POST'\s*,\s*'\/fapi\/v1\/algoOrder'/g) ?? []).length;
  }

  assert.deepEqual(
    offenders,
    [],
    '★★★ 下单/撤单端点在适配器之外被直接调用了：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    适配器（`binance/broker.ts`）是**唯一**同时知道合约过滤器、又在下单路径上的层，' +
      '在别处直接打端点等于绕过它的归一化与预检（历史上因此吃过 `-1111` / `-4164`）。',
  );
  assert.equal(postOrder, 1, `★ /fapi/v1/order 的 POST 应有且只有 1 处（placeStandardOrder），实际 ${postOrder}`);
  assert.equal(postAlgo, 1, `★ /fapi/v1/algoOrder 的 POST 应有且只有 1 处（placeAlgoOrder），实际 ${postAlgo}`);
});

/* -------------------------------------------------------------------------- */
/*  ⑥ 人造校准：把判据跑在**故意写坏**的源码上，它必须报错                        */
/* -------------------------------------------------------------------------- */

test('★★★ 判据必须能真的报出绕过（人造源码校准）—— 否则上面全是在空转', () => {
  /* --- ① 多一处没登记的下单点：新增一个"顺手平掉"的私有方法 --- */
  const BACKDOOR = [
    'class Fake {',
    '  private async executeOpen(decision: Decision) {',
    '    await this.deps.broker.placeOrder({ symbol: decision.symbol, side: "BUY", type: "MARKET" });',
    '  }',
    '  private async sneakClose(symbol: string) {',
    '    await this.deps.broker.placeOrder({ symbol, side: "SELL", type: "MARKET" });',
    '  }',
    '}',
  ].join('\n');
  const backdoorFindings = scanOrderSites(BACKDOOR, membersOf(BACKDOOR), PLACE_ORDER_SITES);
  assert.equal(backdoorFindings.length, 2, '★ 校准夹具本身没被扫全 —— 判据或解析有问题');
  assert.equal(
    orderSiteProblems(backdoorFindings).length,
    1,
    '★★★ 「新增一处没登记的下单点」必须被报出来 —— 这是本守卫存在的全部理由',
  );

  /* --- ② 载荷性质被改：平仓点悄悄去掉 reduceOnly（那就变成了一次反向开仓） --- */
  const WRONG_KIND = [
    'class Fake {',
    '  private async executeClose() {',
    '    await this.deps.broker.placeOrder({ symbol, side: "SELL", type: "MARKET" });',
    '  }',
    '}',
  ].join('\n');
  assert.equal(
    orderSiteProblems(scanOrderSites(WRONG_KIND, membersOf(WRONG_KIND), PLACE_ORDER_SITES)).length,
    1,
    '★★★ 「平仓点丢了 reduceOnly」必须被报出来 —— 那会让一张平仓单变成反向开仓',
  );

  /* --- ③ 新增一个调用者：某个新帮手直接调 executeOpen --- */
  const NEW_CALLER = [
    'class Fake {',
    '  private async runCycleBody() {',
    '    for (const decision of verdict.approved) { await this.executeOpen(decision); }',
    '  }',
    '  private async executeOpen() {}',
    '  private async opportunisticEntry() { await this.executeOpen(); }',
    '}',
  ].join('\n');
  const cal = callerProblems(NEW_CALLER, membersOf(NEW_CALLER), CALLERS);
  assert.ok(
    cal.offenders.some((o) => o.includes('opportunisticEntry')),
    '★★★ 「没登记的调用者」必须被报出来 —— 否则新增一条下单路径不会被拦',
  );

  /* --- ④ 调用图空了（方法被改名/被删）：必须报"缺少登记的调用者"，不能静默通过 --- */
  const EMPTY = 'class Fake {\n  private async anything() {}\n}';
  const emptyCal = callerProblems(EMPTY, membersOf(EMPTY), CALLERS);
  assert.ok(
    emptyCal.offenders.length > 0,
    '★★★ 调用图为空时必须有报错 —— 否则"⊆ 白名单"会因为空集而恒真（正是 perSymbolWiring 的教训）',
  );

  /* --- ⑤ balancedFrom 取不到闭合必须抛错，不许静默返回空串 --- */
  assert.throws(
    () => balancedFrom('{ a: (', 0),
    /没有闭合/,
    '★★★ 配平失败必须抛错 —— 静默返回空串会让判据对"畸形源码"一律通过',
  );

  /* --- ⑥ 校准判据本身：合法源码不许被误报 --- */
  assert.deepEqual(
    orderSiteProblems(scanOrderSites(AUTO_TRADER, MEMBERS, PLACE_ORDER_SITES)),
    [],
    '★★ 真实的 `autoTrader.ts` 不许被误报（改了业务代码就要回头看这张登记表）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ⑦ 元守卫：禁止恒真断言（本仓库已有一条这样失效的守卫）                        */
/* -------------------------------------------------------------------------- */

/**
 * 已知的恒真断言。**这是一张"待还的债"清单，不是一个白名单**：
 * 里面每一条都已由别的任务承接修复（修好后把这一行删掉，本守卫不需要同步改）。
 */
const KNOWN_VACUOUS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'trader/agent/perSymbolWiring.test.ts',
    why: '`/regex/.test(CODE) === false || true` —— 整条断言恒真（已由 t43 承接修复）',
  },
];

/** 恒真形状：无论左侧是什么，整个表达式都是 true。 */
const VACUOUS_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\|\|\s*true\b/, why: '`|| true` 让判据恒真' },
  { re: /&&\s*true\b/, why: '`&& true` 让判据恒真' },
  { re: /\?\s*true\s*:\s*true\b/, why: '两个分支都是 true' },
];

/** 扫一份测试源码里"恒真的断言"（返回 `行号：说明`）。 */
function vacuousAssertions(code: string): string[] {
  const out: string[] = [];
  /*
   * ⚠️ **不能喂 `codeOnly()` 的结果**（见 `plainCode()` 的说明：按行丢注释会
   * 吃掉多行模板字面量里的字符，把 `assert` 实参的括号弄不配平）。
   * `plainCode()` 把注释/字符串/正则一起抹成空格，长度与换行都保留 —— 配平器才可靠。
   */
  const cleaned = plainCode(code);
  const re = /\bassert\.([A-Za-z]+)\s*\(/g;
  for (const m of cleaned.matchAll(re)) {
    const name = m[1]!;
    const at = (m.index ?? 0) + m[0].length - 1;
    const args = balancedFrom(cleaned, at);
    const line = cleaned.slice(0, m.index ?? 0).split('\n').length;
    for (const p of VACUOUS_PATTERNS) {
      if (p.re.test(args)) out.push(`第 ${line} 行：assert.${name}(…) —— ${p.why}`);
    }
  }
  return out;
}

test('★★★ 禁止恒真断言：`|| true` / `&& true` / `? true : true` 一律不许出现在断言里', () => {
  /* 校准：人造的恒真断言必须被报出来（否则这条元守卫自己就是空转）。 */
  assert.equal(
    vacuousAssertions("assert.ok(/x/.test(CODE) === false || true, 'msg');").length,
    1,
    '★★★ 校准失败：人造的 `=== false || true` 没被扫出来',
  );
  assert.equal(
    vacuousAssertions("assert.ok(/x/.test(CODE), 'msg 里提到 || true 不算');").length,
    0,
    '★★ 报错文案里出现 `|| true` 不该被误报（字符串内容必须先被抹掉）',
  );

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };

  const known = new Set(KNOWN_VACUOUS.map((k) => k.file));
  const offenders: string[] = [];
  for (const file of walk(SERVER_SRC)) {
    const rel = file.slice(SERVER_SRC.length + 1).replace(/\\/g, '/');
    const found = vacuousAssertions(plainCode(readFileSync(file, 'utf8')));
    if (found.length === 0) continue;
    if (known.has(rel)) continue;
    offenders.push(`${rel}：${found.join('；')}`);
  }

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些测试里有**恒真断言**（无论被测代码怎样都会通过）：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ⚠️ 本仓库已经有过一次真实教训：`trader/agent/perSymbolWiring.test.ts:38` 的' +
      '`=== false || true` 让整条用例永远为真（已知项记在 `KNOWN_VACUOUS` 里，已由 t43 承接）。\n' +
      '    ✅ 修法：把左侧那半句写成**独立的 `assert`**（它本来就是想断言"只应有一处"）。',
  );
});
