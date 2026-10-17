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
 * 外加四条横向守卫：
 *   · **broker 表面被钉住** —— `autoTrader.ts` 用到的适配器方法集合必须与登记表精确相等
 *     （新增一个 `placeOrderXxx` 之类的适配器方法会让它响），且不许把 `broker` 别名/解构；
 *   · **`this` 不许被存进变量**（别名 `const self = this`、从 `this` 解构、类型断言后
 *     括号取成员）—— 这三种形状会让所有按 `this.<方法>(` 的扫描一起失效（t41 `GRD-A1/A2/A3`）；
 *   · **下单端点只有适配器能打**（`/fapi/v1/order` 与 `/fapi/v1/algoOrder` 的 POST 各一处），
 *     且端点的**字面量**只许出现在登记过的文件里（t42 `S3`）；
 *   · **恒真断言一律禁止**（见文件末尾 —— 本仓库已有一条这样失效的守卫）。
 *
 * ## 2026-10-17（t57）：四处"少报"缺口已补，补的是覆盖面而不是措辞
 *
 * `t41` 独立验证判 `needs_revision`、`t42` 审查记了 `S2/S3`，两份工作指向同一批形状。
 * 本轮把它们**逐条变成能红的判据**（并有负向校准）：
 *
 * | 缺口 | 形状 | 现在的处理 |
 * | --- | --- | --- |
 * | `GRD-A3` | `const self = this; self.executeOpen(…)` | **扩大覆盖面**：`this` 别名一律禁止（别名没有正当理由）；且 `callSitesOf` 可登记别名并解析（证明"看见"这件事真的做得到） |
 * | `GRD-A2` | `const t = this as unknown as Record<…>; t['executeOpen'](…)` | **扩大覆盖面**：`= this as …` 被识别为别名；`别名[` 动态取成员一律禁止 |
 * | `GRD-A1` | `const { executeOpen } = this; executeOpen(…)`（t42 `S2`） | **扩大覆盖面**：从 `this` 解构一律禁止（解构出来的方法调用**没有接收者**，静态文本里连名字归属都丢了） |
 * | `GRD-B1` | 把 `await this.executeOpen(…)` 插进 `runCycleBody` 循环**之外**的另一分支 | **扩大覆盖面**：判据③ 从"存在性"升级为**计数 + 行区间归属**（`runCycleBody` 内恰好 1 处、且必须落在循环的行区间里） |
 * | t42 `S3` | `fetch(BASE + '/fapi/v1/order')`、`'/fapi/v1/' + 'order'` | **扩大覆盖面**：端点**字面量/前缀**只许出现在登记文件里，且"请求上下文 + 端点字面量"必须落在适配器内 |
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
 * · **不做控制流分析（残余）**：判据③ 现在守得住"把分派挪到 `runCycleBody` 里循环之外"
 *   （计数 + 行区间），但**守不住**"在循环体内再加一个新的 `if` 分支"——
 *   那仍然是 approved 之后的执行，安全性没有变化；而"改掉循环本身"
 *   （换成 `for…of approved` 之外的形式）会让循环锚点找不到 → **红灯**，不是静默通过。
 * · **别名这一族只覆盖"声明形式"**（残余）：`const self = this`、`= this as …`、
 *   `const { x } = this`、`this[…]`、`self[…]` 全部禁止（今天实测 0 处）。
 *   仍抓不到的是**把 `this` 当参数传出去**（`helper(this)` 后在 helper 里 `x.executeOpen(…)`）
 *   与**把方法当值传出去**（`const f = this.executeOpen; f(d)`）——
 *   它们都跨了方法边界，静态文本里没有接收者绑定可依。
 * · **不做类型/绑定分析**：它读的是源码文本（`plainCode()` 把注释/字符串/正则抹成空格后）。
 *   通过 `import` 拿一个 `AutoTrader` 实例、再用 `as any` 调私有方法**不会**被这里挡住
 *   —— 但会被"跨文件调用"那条与 TypeScript 的 `private` 一起挡住。
 * · 模板字面量里的 `${…}` 插值也一并被抹掉了 —— 所以"在模板字符串里调用下单方法"
 *   这种形态（今天不存在，也没有正当理由）看不见。
 * · **动态字符串调用**无法穷举 —— 所以额外**禁止** `this[…]` 与 `<this 别名>[…]`
 *   这两种括号取成员形式（当前实测 0 处）。运行时拼接出的方法名仍然看不见。
 * · **端点守卫的残余**：它现在盯的是 `/fapi/v1/…` 这个**前缀**（含拼接式），
 *   但把路径拆成不含该前缀的片段（`BASE + '/order'`）够不着；
 *   扫描范围仍是 `packages/server/src`（仓库根的 `scripts/` 不走这里）。
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
/**
 * **同一份源码、但保留字符串内容**（t63）。
 *
 * ⚠️ 为什么需要第二份：`(this as …)['executeOpen'](…)` 这种拼写的**方法名在字符串里**，
 * 而默认的 `plainCode()` 会把字符串内容抹成空格 —— 那份扫描**一条都看不到它**
 * （本仓库为"字符串被抹掉导致守卫静默失效"付过代价：端点守卫当年因此把 1 报成 0）。
 *
 * ⚠️ 两份都是**长度保持**的，所以行号一致；报出来的行号仍然就是文件行号。
 */
const AUTO_TRADER_STR = plainCode(AUTO_TRADER_RAW, true);

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

/* -------------------------------------------------------------------------- */
/*  接收者归一化：内联类型断言取成员（t63 —— 补 t58 的 F1/F2/F3）                  */
/* -------------------------------------------------------------------------- */
/*                                                                             */
/* ## 为什么需要这一层（t58 复审抓到的新隐身形状）                                 */
/*                                                                             */
/* t57 让判据认得了「`this` 存进变量」那一族（别名 / 解构 / `this[…]`），           */
/* 但**内联**写法仍然全隐身 —— 它连变量都没有：                                   */
/* ```                                                                          */
/*   await (this as unknown as { executeOpen: … }).executeOpen(d);   ← F1 high   */
/*   await (this as unknown as Record<string, …>)['executeOpen'](d);  ← F2        */
/*   await (this.deps.broker as unknown as { placeOrder: … }).placeOrder({}); ← F3 */
/* ```                                                                          */
/* 三种写法**全部通过 `tsc --noEmit --strict`**（t58 建过 `compileProbe.ts` 验证）， */
/* 而旧判据（要求接收者字面就是 `this` / `this.deps.broker`）**一条都不报**。        */
/*                                                                             */
/* ## 修法：不再要求"字面相等"，改成"**归一化后必须恰好等于那个接收者**"            */
/*                                                                             */
/* 分两个口径（这是这套判据的关键设计）：                                          */
/* ```                                                                          */
/*   normalized —— 剥掉 await/void/return/yield 前缀、外层括号、顶层 as/satisfies、 */
/*                 尾 !、三元前缀 → 用来**认得出这是谁在调用**（可归因）              */
/*   bare       —— 只剥"语句前缀"（await/return/三元/尾 !），**保留括号与 as**        */
/*                 → 用来**判断它是不是被伪装过**（括号/断言一律算伪装）              */
/* ```                                                                          */
/* 判据：每个敏感方法的成员调用，`bare` 必须**恰好等于**该方法的合法接收者；            */
/* 只要 `bare !== normalized`（说明中间夹了括号/`as`/`!`）就报 —— **fail-closed**。  */
/*                                                                             */
/* ⚠️ 基线实测（`.dsh/t63-probe.txt`）：敏感方法的非调用引用 **0 处**、               */
/* 括号取成员调用 **0 处**、内联断言 **0 处** —— 所以这套判据**不改变任何现有代码**， */
/* 只堵住"换个拼写就隐身"这条路。                                                 */
/* -------------------------------------------------------------------------- */

/** 从 `closeIndex` 处的 `)`/`]`/`}` 往回找配对的 `(`/`[`/`{`（找不到返回 `-1`）。 */
function matchBack(code: string, closeIndex: number): number {
  const ch = code[closeIndex];
  const open = ch === ')' ? '(' : ch === ']' ? '[' : ch === '}' ? '{' : null;
  if (open === null) return -1;
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    const c = code[i] as string;
    if (c === ch) depth += 1;
    else if (c === open) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 取「`accessIndex` 处的 `.` 或 `[` 的**接收者表达式**」。
 *
 * ⚠️ **必须往回走整个表达式，不能只取紧邻的标识符** ——
 * `(this as unknown as {…}).executeOpen(` 里紧邻 `.` 的是一个 `)`，
 * 只看标识符会拿到空串（那正是 t58 的 F1 能隐身的机理）。
 */
function receiverAt(code: string, accessIndex: number): string {
  let i = accessIndex - 1;
  while (i >= 0) {
    const ch = code[i] as string;
    if (/\s/.test(ch)) {
      i -= 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = matchBack(code, i);
      if (open < 0) break;
      i = open - 1;
      continue;
    }
    /* `.` 也要一起吃掉：`this.deps.broker.placeOrder(` 的接收者是整条链。 */
    if (/[A-Za-z0-9_$?.]/.test(ch)) {
      i -= 1;
      continue;
    }
    break;
  }
  return code.slice(i + 1, accessIndex);
}

/** 归一化：剥语句前缀 → 外层括号 → 顶层 `as`/`satisfies` → 尾 `!`（反复到不动为止）。 */
function normalizeReceiver(raw: string): string {
  let s = raw.trim();
  for (let guard = 0; guard < 12; guard += 1) {
    const before = s;
    s = s.replace(/^(?:await|void|return|yield)\s+/, '');
    const wrapped = /^\(([\s\S]*)\)$/.exec(s);
    if (wrapped !== null) s = wrapped[1]!;
    /* 三元：`cond ? a : b` 里接收者是最后一段（只处理"`?` 之后没有 `:`"的前缀形态）。 */
    const q = s.lastIndexOf('?');
    if (q >= 0 && !s.slice(q).includes(':')) s = s.slice(q + 1);
    s = s.trim();
    if (s === before) break;
  }
  /* 顶层 `as` / `satisfies`：按 `()[]{}` 深度找，避免切到类型里的尖括号/花括号。 */
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && /^\s+(?:as|satisfies)\s/.test(s.slice(i))) {
      s = s.slice(0, i);
      break;
    }
  }
  return s.trim().replace(/!$/, '').replace(/\s+/g, '');
}

/**
 * `bare`：**只**剥语句前缀（`await`/`void`/`return`/`yield`、三元前缀、尾 `!`）。
 *
 * ⚠️ **刻意不剥括号、不剥 `as`** —— 那两个正是"伪装"的标记：
 * `(this as …).executeOpen(` 的 `bare` 是 `(thisas…)`，与 `this` 不等 ⇒ 报出来。
 */
function bareReceiver(raw: string): string {
  let s = raw.trim();
  for (let guard = 0; guard < 6; guard += 1) {
    const before = s;
    s = s.replace(/^(?:await|void|return|yield)\s+/, '').trim();
    const q = s.lastIndexOf('?');
    if (q >= 0 && !s.slice(q).includes(':')) s = s.slice(q + 1).trim();
    if (s === before) break;
  }
  return s.replace(/!$/, '').replace(/\s+/g, '');
}

interface MemberAccess {
  line: number;
  /** `dot` = `.name(`；`bracket` = `['name'](`。 */
  kind: 'dot' | 'bracket';
  /** 方法名（`bracket` 形态的名字来自字符串字面量）。 */
  name: string;
  /** 原样接收者（未归一化）。 */
  receiver: string;
  /** 归一化后的接收者 —— 用来**认得出这是谁在调用**。 */
  normalized: string;
  /** 只剥语句前缀的接收者 —— 用来**判断有没有被伪装**。 */
  bare: string;
  /** 实参左括号 `(` 的下标（配平取载荷时要它）。 */
  callIndex: number;
}

/**
 * 扫出全部**成员调用**（`.` 与 `['name']` 两种拼写），并给出接收者的两种口径。
 *
 * @param code        剥掉注释/字符串/正则的源码（用于 `.name(` —— 名字在代码里）
 * @param codeStrings **保留字符串内容**的同一份源码（用于 `['name'](` —— 名字在字符串里）
 * @param names       只收这些方法名的调用
 *
 * ⚠️ 两份源码都是**长度保持**的（`plainCode()` 的两种模式），所以行号一致。
 * ⚠️ `['name'](` 必须在"保留字符串"的那份上扫 —— 否则名字被抹成空格，
 *    那种拼写会**一条都扫不到**（本仓库为"字符串被抹掉导致守卫静默失效"付过代价，
 *    见端点守卫那段 `keepStrings = true` 的说明）。
 */
function memberAccessesOf(code: string, codeStrings: string, names: readonly string[]): MemberAccess[] {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameSet = new Set(names);
  const out: MemberAccess[] = [];

  /* ① `.name(` —— 在**剥字符串**的那份上扫（避免把文案里的 `.foo(` 当成调用）。 */
  for (const m of code.matchAll(/(\??\.)\s*([A-Za-z_$][\w$]*)\s*(?=\()/g)) {
    const name = m[2]!;
    if (!nameSet.has(name)) continue;
    const dotIndex = (m.index ?? 0) + m[1]!.length - 1;
    const receiver = receiverAt(code, dotIndex);
    const callIndex = (m.index ?? 0) + m[0].length;
    out.push({
      line: lineAt(code, m.index ?? 0),
      kind: 'dot',
      name,
      receiver,
      normalized: normalizeReceiver(receiver),
      bare: bareReceiver(receiver),
      callIndex,
    });
  }

  /* ② `['name'](` —— 在**保留字符串**的那份上扫（名字在字符串里）。 */
  for (const m of codeStrings.matchAll(/\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]\s*(?=\()/g)) {
    const name = m[2]!;
    if (!nameSet.has(name)) continue;
    const bracketIndex = m.index ?? 0;
    const receiver = receiverAt(codeStrings, bracketIndex);
    out.push({
      line: lineAt(codeStrings, bracketIndex),
      kind: 'bracket',
      name,
      receiver,
      normalized: normalizeReceiver(receiver),
      bare: bareReceiver(receiver),
      callIndex: (m.index ?? 0) + m[0].length,
    });
  }

  return out.sort((a, b) => a.line - b.line);
}

/**
 * **敏感方法的接收者必须是字面 `this`**（t63，补 F1/F2）。
 *
 * 判据：对每个敏感方法名，取全部成员调用（`.` 与 `['name']` 两种拼写），
 * 要求 `bare === 'this'`。任何**括号包裹 / 类型断言 / `!`** 都会让 `bare !== 'this'` ⇒ 报。
 *
 * ⚠️ 这不是"多报一点"，而是把口径从**字面匹配**换成**结构匹配**：
 * 字面匹配的前提是"作者会照着我们期待的样子写"，而 t58 证明了**换个拼写就隐身**。
 */
function sensitiveReceiverProblems(code: string, codeStrings: string, names: readonly string[]): string[] {
  const problems: string[] = [];
  for (const access of memberAccessesOf(code, codeStrings, names)) {
    if (access.bare === 'this') continue;
    const disguised = access.bare !== access.normalized;
    problems.push(
      `第 ${access.line} 行：\`${access.name}\` 的接收者是「${access.receiver.trim()}」` +
        (disguised
          ? `—— **它归一化之后就是 \`this\`，却被括号/类型断言包了一层**。` +
            '这种写法让所有"接收者字面是 this"的扫描全部隐身（t58 的 F1/F2）。'
          : `—— 敏感方法只许写成 \`this.${access.name}(…)\`。`),
    );
  }
  return problems;
}

/**
 * **`placeOrder` 的接收者必须是字面 `this.deps.broker`**（t63，补 F3）。
 *
 * 与上面同一个口径，只是接收者换成 `this.deps.broker`：
 * `(this.deps.broker as …).placeOrder({})` 的 `bare` 是 `(this.deps.brokeras…)` ≠ `this.deps.broker` ⇒ 报。
 *
 * ⚠️ 这条**同时**把"换了接收者的 placeOrder"堵住：任何 `.placeOrder(` 若接收者不是
 * `this.deps.broker`（例如 `(someOther as any).placeOrder(`），也会在这里被报出来 ——
 * 那正是"下单点穷举"要防的形状（它数的是 `this.deps.broker.placeOrder(` 的字面出现次数）。
 */
function placeOrderReceiverProblems(code: string, codeStrings: string): string[] {
  const problems: string[] = [];
  for (const access of memberAccessesOf(code, codeStrings, ['placeOrder'])) {
    if (access.bare === 'this.deps.broker') continue;
    const disguised = access.bare !== access.normalized;
    problems.push(
      `第 ${access.line} 行：\`placeOrder\` 的接收者是「${access.receiver.trim()}」` +
        (disguised
          ? '—— **它归一化之后就是 `this.deps.broker`，却被括号/类型断言包了一层**。' +
            '那样"`this.deps.broker.placeOrder(` 出现几次"这条穷举判据会数不到它（t58 的 F3）。'
          : '—— 下单点只许写成 `this.deps.broker.placeOrder(…)`（§2.1：唯一的下单入口）。'),
    );
  }
  return problems;
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
 * 找出代码里所有「接收者是 `this`（或**已登记的 `this` 别名**）的 `<name>(` 调用」。
 *
 * ⚠️ **空白容忍**（`this.deps.broker\n  .placeOrder(` 这种折行在 `autoTrader.ts` 里真实存在，
 * 实测 3 处）：用字面 `indexOf` 去找会**漏掉折行的调用点** —— 而"漏掉"在这里
 * 正是最坏的失效形态（守卫静默通过）。
 *
 * ## 接收者判据的两次升级（都因为"换个拼写就隐身"）
 *
 * · **t57**：加了 `aliases` 参数 —— 只认 `this.` 前缀时，`const self = this; self.executeOpen(…)`
 *   这一行改动就能让全部扫描瞎掉。
 * · **t63**：接收者改成**归一化**比对（`normalizeReceiver`）—— 于是
 *   `(this as unknown as {…}).executeOpen(d)` 与 `(this as …)['executeOpen'](d)`
 *   也被算作"`this` 上的调用"（t58 的 F1/F2）。它们同时会被
 *   `sensitiveReceiverProblems()` 报成"伪装"——**归因**与**报警**两条都补上。
 *
 * @param code        剥掉注释/字符串/正则的源码
 * @param codeStrings 保留字符串内容的同一份源码（`['name'](` 形态需要它）
 */
function callSitesOf(
  code: string,
  name: string,
  members: readonly Member[],
  /** 额外的接收者名（已登记的 `this` 别名）。 */
  aliases: readonly string[] = [],
  codeStrings: string = code,
): CallSite[] {
  /*
   * ⚠️⚠️ **`name` 可以是两级成员访问**（`risk.review`）—— t63 修的一个**假红**。
   *
   * 第一版我把接收者改成「归一化后必须恰好等于 `this`」，而 `risk.review` 这条
   * 用例传的 `name` 是**两段**：它的真实写法是 `this.risk.review(`，
   * 接收者是 `this.risk`（不是 `this`）⇒ 判据一条都匹配不上 ⇒
   * **一条真实存在的调用被数成 0 ⇒ 假红**（实测：那条断言报"实际 0 处，应 2 处"）。
   *
   * 修法：按 `.` 拆开 —— 最后一段是**方法名**，前面那几段是**接收者的尾部**。
   * 于是 `risk.review` ⇒ 方法名 `review`、要求的接收者 `this.risk`。
   * 而「接收者字面必须是 `this`（或其别名）」这条红线**只对单段名成立**
   * （`this.executeOpen(` / `self.executeOpen(`）；两段名的接收者本来就带一层属性。
   *
   * ⚠️ 校准纪律：**假红与假绿一样有害** —— 一条恒返回 0 的检查会被当成"检查通过"，
   * 而一条真实调用被数成 0 会训练人忽略红色。所以这条改动**必须**有
   * "基线对照"（在未修改的 `autoTrader.ts` 上全部判据必须全绿）。
   */
  const parts = name.split('.');
  const methodName = parts[parts.length - 1]!;
  const receiverPrefix = parts.slice(0, -1).join('.');
  const wanted = new Set(['this', ...aliases].map((r) => (receiverPrefix.length > 0 ? `${r}.${receiverPrefix}` : r)));
  const out: CallSite[] = [];
  for (const access of memberAccessesOf(code, codeStrings, [methodName])) {
    /*
     * ⚠️ **接收者用 `normalized` 比对**（t63）：于是
     *   `(this as …).executeOpen(` / `(this as …)['executeOpen'](`
     * 也算作"`this` 上的调用" —— 它们会被归因到正确的调用者（而不是凭空消失），
     * 同时由 `sensitiveReceiverProblems()` 报成"伪装"。
     */
    if (!wanted.has(access.normalized)) continue;
    out.push({
      line: access.line,
      args: balancedFrom(code, access.callIndex),
      inMember: enclosingMember(members, access.line),
    });
  }
  return out;
}

/**
 * 取某一行上「`name` 的成员调用」的实参块（配平、含括号）。
 *
 * ⚠️ 取不到时返回 `'()'` 而不是空串：空串会让"载荷性质"判据（`reduceOnly: true`）
 * 一律判成 `entry` —— 那是**误报**，比不报更糟（会让人去改一张本来正确的表）。
 */
function argsAtMemberCall(code: string, line: number, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\\.\\s*${escaped}|\\[\\s*['"\`]${escaped}['"\`]\\s*\\])\\s*\\(`, 'g');
  const lineStart = line === 1 ? 0 : code.split('\n').slice(0, line - 1).join('\n').length + 1;
  const lineEnd = lineStart + (code.slice(lineStart).split('\n')[0]?.length ?? 0);
  for (const m of code.slice(lineStart, lineEnd).matchAll(re)) {
    const at = lineStart + (m.index ?? 0) + m[0].length - 1;
    return balancedFrom(code, at);
  }
  return '()';
}

/* -------------------------------------------------------------------------- */
/*  `this` 别名 / 解构 / 括号取成员（t41 GRD-A1/A2/A3、t42 S2）                  */
/* -------------------------------------------------------------------------- */

/** 一行文本的 1-based 行号。 */
function lineAt(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

interface ThisAlias {
  name: string;
  line: number;
  how: 'alias' | 'destructure';
  /** `how === 'destructure'` 时被取出来的那些名字。 */
  names: string[];
}

/**
 * 找出**把 `this` 本身存进变量**的地方 —— 别名、解构、类型断言后索引的共同入口。
 *
 * ## 判据为什么是 `=\s*this(?!\s*\.)`
 *
 * `(?!\s*\.)` 而不是 `(?!\.)`：本仓库里 `this.deps...` 的链式调用会**折行**
 * （`const live = await this.deps.broker\n  .getOrder(…)`，实测 3 处），
 * 只否掉紧邻的点会让 `\s*` 退一步吃掉一个空格、回溯成功 —— 把真实的链式调用误判成别名
 * （这个坑在 `broker` 别名判据那里已经踩过一次，见下文 `ALIAS_PATTERNS` 的注释）。
 *
 * ⚠️ 判据**只认"裸 this"**：`= this.deps.agent` 这类（把依赖存进变量）不在这里，
 * 它们由 `broker` 别名判据单独管。
 */
function thisAliasesOf(code: string): ThisAlias[] {
  const out: ThisAlias[] = [];
  /* ① 别名：`const self = this;`、`let t = this as unknown as Record<…>`、`x = this;` */
  const aliasRe = /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?this(?!\s*\.)/g;
  for (const m of code.matchAll(aliasRe)) {
    out.push({ name: m[1]!, line: lineAt(code, m.index ?? 0), how: 'alias', names: [] });
  }
  /* ② 解构：`const { executeOpen, executeClose } = this;` */
  const destructureRe = /\{\s*([^{}]*)\}\s*=\s*(?:await\s+)?this(?!\s*\.)/g;
  for (const m of code.matchAll(destructureRe)) {
    const names = (m[1] ?? '')
      .split(/[,:\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    out.push({ name: '(解构)', line: lineAt(code, m.index ?? 0), how: 'destructure', names });
  }
  return out;
}

/** `this[` / `<别名>[` 这类**括号取成员**（动态名字在静态文本里已经不存在了）。 */
function dynamicMemberAccesses(code: string, receivers: readonly string[]): Array<{ line: number; text: string }> {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:${receivers.map(escape).join('|')})\\b\\s*\\[`, 'g');
  return [...code.matchAll(re)].map((m) => ({
    line: lineAt(code, m.index ?? 0),
    text: code
      .slice(m.index ?? 0, (m.index ?? 0) + 40)
      .split('\n')[0]!
      .trim(),
  }));
}

/**
 * `this` 别名这一族的**全部问题**（别名 / 解构 / 括号取成员）。
 *
 * 返回空数组 = 今天 `autoTrader.ts` 的常态（实测三种形状各 0 处）。
 */
function aliasProblems(code: string): string[] {
  const out: string[] = [];
  const aliases = thisAliasesOf(code);
  const aliasNames: string[] = [];
  for (const a of aliases) {
    if (a.how === 'alias') {
      aliasNames.push(a.name);
      out.push(
        `第 ${a.line} 行：\`${a.name} = this\` —— **把 this 存进了变量**。` +
          '本守卫所有按 `this.<方法>(` 的扫描都会因此失效（看不见真正的调用点）。',
      );
      continue;
    }
    out.push(
      `第 ${a.line} 行：从 this 解构出 [${a.names.join(', ') || '?'}] —— ` +
        '解构出来的方法**调用时没有接收者**，静态文本里连"是谁调的"都丢了。',
    );
  }
  /*
   * ⚠️ 括号取成员**单独报**（而不是只依赖上面的别名报告）：
   *   · `this['execute' + 'Open'](…)` 根本没有别名语句；
   *   · `t['executeOpen'](…)`（类型断言后的索引）里那个名字是**字符串**，
   *     而 `plainCode()` 会把字符串内容抹成空格 —— 名字在静态文本里已经不存在了。
   */
  for (const m of dynamicMemberAccesses(code, ['this', ...aliasNames])) {
    out.push(`第 ${m.line} 行：\`${m.text}\` —— 括号取成员（动态名）。静态扫描看不见这个名字。`);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  判据③的升级：分派的「计数 + 行区间归属」（t41 GRD-B1）                        */
/* -------------------------------------------------------------------------- */

const APPROVED_LOOP_NEEDLE = 'for (const decision of verdict.approved) {';

/** approved 循环体内必须出现的 6 个执行分派。 */
const DISPATCH_METHODS: readonly string[] = [
  'executeCancelPending',
  'executeClose',
  'executeAdjust',
  'executeAdd',
  'executeReduce',
  'executeOpen',
];

/**
 * approved 消费路径的**归属判据**。
 *
 * ## 为什么"存在性"不够（`GRD-B1`）
 *
 * 旧判据是 `loopBody.includes('this.executeOpen(')` —— 它只问"循环里**有没有**这个词"。
 * 于是把分派**插到循环之外**、同时**保留**循环里那一处，判据照样全绿：
 * ```
 *   if (someFlag) { await this.executeOpen(decision); }   ← 循环之外，没有经过 verdict.approved
 *   for (const decision of verdict.approved) { … }        ← 原来那一处还在
 * ```
 * 两条路径都能下单，而守卫一声不响 —— 这正是"少报"。
 *
 * ## 现在的判据（计数 + 行区间）
 *
 * 对 6 个分派逐一：
 *   ① `runCycleBody` 里**恰好 1 处**调用（0 处 = 分派丢了；2 处 = 多了一条执行路径）；
 *   ② 那一处必须落在 approved 循环的**行区间内**（`balancedFrom` 给出区间，
 *      见 `t41` 的建议）。
 */
function dispatchOwnershipProblems(code: string, aliases: readonly string[] = []): string[] {
  const problems: string[] = [];
  const members = membersOf(code);
  const loopAt = code.indexOf(APPROVED_LOOP_NEEDLE);
  if (loopAt < 0) {
    return [
      `找不到 \`${APPROVED_LOOP_NEEDLE}\` —— §2.1 要求 AutoTrader 只执行 approved 里的决策，` +
        '这个循环是那句话的实现；锚点没了，本判据无法工作（必须报错而不是沉默）',
    ];
  }
  if (code.split(APPROVED_LOOP_NEEDLE).length - 1 !== 1) {
    problems.push(`approved 消费循环出现了不止一次 —— 执行路径必须只有一个（多出来的那一处要单独审）`);
  }
  const loopBody = balancedFrom(code, loopAt + APPROVED_LOOP_NEEDLE.length - 1);
  const loopStart = lineAt(code, loopAt);
  const loopEnd = lineAt(code, loopAt + loopBody.length - 1);

  for (const name of DISPATCH_METHODS) {
    const sites = callSitesOf(code, name, members, aliases);
    const inCycle = sites.filter((s) => s.inMember === 'runCycleBody');
    if (inCycle.length === 0) {      problems.push(
        `${name}：runCycleBody 里**一处调用都没有** —— 分派丢了（或它被挪到了别的方法里，` +
          '那是一条新的执行入口，要单独审）',
      );
      continue;
    }
    if (inCycle.length > 1) {
      problems.push(
        `${name}：runCycleBody 里有 ${inCycle.length} 处调用（第 ${inCycle.map((s) => s.line).join('、')} 行）—— ` +
          '应**恰好 1 处**：多出来的那一处是一条**没有经过 approved 消费**的执行路径。',
      );
      continue;
    }
    const only = inCycle[0]!;
    if (only.line < loopStart || only.line > loopEnd) {
      problems.push(
        `第 ${only.line} 行：${name} 的调用落在 approved 循环**之外**` +
          `（循环是第 ${loopStart}–${loopEnd} 行）—— 那条路径没有消费 verdict.approved。`,
      );
    }
  }
  return problems;
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
  /** 已登记的 `this` 别名（生产路径传 `thisAliasesOf()` 的结果，今天为空）。 */
  aliases: readonly string[] = [],
): { offenders: string[]; actual: Map<string, Set<string | null>> } {
  const offenders: string[] = [];
  const actual = new Map<string, Set<string | null>>();
  for (const entry of table) {
    const sites = callSitesOf(code, entry.callee, members, aliases);
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

/** 会下单 / 直接通往下单的方法名（`sensitiveReceiverProblems` 用它）。 */
const SENSITIVE_METHODS: readonly string[] = [
  'executeOpen',
  'executeClose',
  'executeAdd',
  'executeReduce',
  'executeAdjust',
  'submitLimitEntry',
  'placeProtection',
  'emergencyFlatten',
  'flattenAndBook',
  'replaceProtection',
  'restoreProtection',
];

test('★★★ 接收者不许被"伪装"：内联类型断言取成员一律红灯（t63 补 t58 的 F1/F2/F3）', () => {
  /*
   * ## 这条测试补的是什么
   *
   * `t58` 复审抓到的形状（**四种拼写，全部通过 `tsc --noEmit --strict`**）：
   * ```
   *   (this as unknown as { executeOpen: … }).executeOpen(d)      ← F1 high
   *   (this as unknown as Record<string, …>)['executeOpen'](d)    ← F2
   *   (this.deps.broker as unknown as { placeOrder: … }).placeOrder({})  ← F3
   * ```
   * 它们在旧判据下**全 0 报**：接收者字面不是 `this` / `this.deps.broker`，
   * 而「别名禁令」要求先有一条**赋值语句**（内联式连变量都没有）。
   *
   * ## 判据（与上面同一个口径，只是从"字面"升级为"结构"）
   *
   * `bare`（只剥语句前缀）必须**恰好等于**该方法的合法接收者：
   *   · 敏感方法 → `this`（或其登记别名）
   *   · `placeOrder` → `this.deps.broker`
   * 任何括号包裹 / 类型断言 / `!` 都会让 `bare` 带上这些字符 ⇒ 报。
   *
   * ⚠️ **基线实测 0 处**（`.dsh/t63-probe.txt`：非调用引用 0、括号取成员调用 0、
   * 内联断言 0）—— 所以这条判据**不改变任何现有代码**。
   */
  const problems = [
    ...sensitiveReceiverProblems(AUTO_TRADER, AUTO_TRADER_STR, SENSITIVE_METHODS),
    ...placeOrderReceiverProblems(AUTO_TRADER, AUTO_TRADER_STR),
  ];
  assert.deepEqual(
    problems,
    [],
    '★★★ 这些调用点的接收者被"伪装"过（括号/类型断言/`!`）：\n' +
      problems.map((p) => `      · ${p}`).join('\n') +
      '\n    ⚠️ 伪装会让所有"接收者字面是 this"的扫描一起隐身（t58 的 F1/F2/F3）。\n' +
      '    ✅ 直接写 `this.xxx(…)` / `this.deps.broker.placeOrder(…)`。',
  );

  /* 非空性：这两条判据必须真的扫到了东西（否则"零问题"是空转）。 */
  const sensitiveCalls = memberAccessesOf(AUTO_TRADER, AUTO_TRADER_STR, SENSITIVE_METHODS);
  assert.ok(
    sensitiveCalls.length >= 30,
    `★ 只扫到 ${sensitiveCalls.length} 处敏感方法调用 —— 扫描口径失效（实测基线应 ≥30 处）`,
  );
  const orderCalls = memberAccessesOf(AUTO_TRADER, AUTO_TRADER_STR, ['placeOrder']);
  assert.equal(orderCalls.length, 7, `★ 只扫到 ${orderCalls.length} 处 placeOrder 调用（应 7 处）—— 扫描口径失效`);
});

test('★★★ 基线对照：改造后的全部判据在未修改的 autoTrader.ts 上必须全绿（不许假红）', () => {
  /*
   * ## 为什么这条单独存在（本批的一条硬纪律）
   *
   * t63 的第一次改造**制造过一条假红**：`callSitesOf(AUTO_TRADER, 'risk.review', …)`
   * 因为 `risk.review` 是**两级成员访问**，接收者归一化后是 `this.risk` 而不是 `this`
   * ⇒ 那条判据把**真实存在的 2 处调用数成了 0** ⇒ `not ok 5`。
   *
   * ⚠️ **假红与假绿同样有害**：假绿让人以为检查过了；假红**训练人忽略红色**
   * （同一批里 `t59` 抓到过反面 —— 一个恒返回 0 的检查被当成"检查通过"）。
   *
   * 所以这里把"基线全绿"**变成一条常驻断言**：任何一个判据在未变异的源码上
   * 报出问题，都必须在这里被看见 —— 而不是等到某天有人以为"这守卫本来就是红的"。
   */
  const baseline: Array<[string, string[]]> = [
    ['orderSiteProblems', orderSiteProblems(scanOrderSites(AUTO_TRADER, MEMBERS, PLACE_ORDER_SITES))],
    ['callerProblems', callerProblems(AUTO_TRADER, MEMBERS, CALLERS, []).offenders],
    ['dispatchOwnershipProblems', dispatchOwnershipProblems(AUTO_TRADER)],
    ['aliasProblems', aliasProblems(AUTO_TRADER)],
    ['sensitiveReceiverProblems', sensitiveReceiverProblems(AUTO_TRADER, AUTO_TRADER_STR, SENSITIVE_METHODS)],
    ['placeOrderReceiverProblems', placeOrderReceiverProblems(AUTO_TRADER, AUTO_TRADER_STR)],
  ];
  const reds = baseline.filter(([, problems]) => problems.length > 0).map(([n]) => n);
  assert.deepEqual(
    reds,
    [],
    '★★★ 未修改的 `autoTrader.ts` 上不该有任何判据报错（**假红**）：\n' +
      baseline
        .filter(([, p]) => p.length > 0)
        .map(([n, p]) => `      · ${n}：${p.length} 条 —— ${p[0]}`)
        .join('\n') +
      '\n    ⚠️ 假红会训练人忽略红色；出现它时**先怀疑判据**，不要改业务代码。',
  );

  /*
   * ② 两级成员访问的正向用例（`t63` 那条假红的形状本身）——
   * 显式断言它数得出 **2 处**，而不是 0 处。
   */
  const reviews = callSitesOf(AUTO_TRADER, 'risk.review', MEMBERS);
  assert.equal(
    reviews.length,
    2,
    `★★★ \`this.risk.review(\` 应有且只有 2 处（主路径 + 执行回执），实际 ${reviews.length} 处。\n` +
      '    ⚠️ 若这里是 0：说明**接收者归一化对两级成员访问失效** —— 那正是 t63 修过的那条假红。',
  );
  assert.deepEqual(
    reviews.map((s) => s.inMember).sort(),
    ['followUpAfterExecution', 'runCycleBody'],
    '★★ `risk.review(` 的归属必须分别是主路径与回执轮',
  );
});

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
  const THIS_ALIASES = thisAliasesOf(AUTO_TRADER).filter((a) => a.how === 'alias').map((a) => a.name);
  const { offenders, actual } = callerProblems(AUTO_TRADER, MEMBERS, CALLERS, THIS_ALIASES);

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

test('★★★ 红线下游：6 个执行分派必须都在 `for (const decision of verdict.approved)` 的循环体内（计数 + 行区间归属）', () => {
  /*
   * ⚠️ 这条判据在 t57 之前只做 `loopBody.includes(needle)` 的**存在性**检查 ——
   * 于是"把分派插到循环之外、同时保留循环里那一处"是**静默通过**的（t41 `GRD-B1`）。
   * 现在改成"`runCycleBody` 里恰好 1 处 + 行号落在循环区间里"，见 `dispatchOwnershipProblems`。
   */
  const THIS_ALIASES = thisAliasesOf(AUTO_TRADER).filter((a) => a.how === 'alias').map((a) => a.name);
  const problems = dispatchOwnershipProblems(AUTO_TRADER, THIS_ALIASES);

  assert.deepEqual(
    problems,
    [],
    '★★★ 执行分派的归属被破坏了：\n' +
      problems.map((p) => `      · ${p}`).join('\n') +
      '\n    把它们移出这个循环 = 让一条没有经过风控裁决的决策走到下单。',
  );

  /* 非空性：这条判据必须真的找到了那个循环与那几个分派（否则"零问题"是空转）。 */
  assert.ok(
    MEMBERS.some((m) => m.name === 'runCycleBody'),
    '★ 找不到 runCycleBody —— 结构变了，请更新本测试',
  );
  assert.ok(
    DISPATCH_METHODS.length === 6,
    `★ 分派名单应当是 6 个，现在是 ${DISPATCH_METHODS.length} 个`,
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

  /*
   * ⚠️ 括号取成员（`this[…]`）与 `this` 别名/解构的禁令**不在这里**——
   * 它们集中在下面那条测试里（`aliasProblems` 一份实现，四处形状一个入口）。
   *
   * ⚠️ 回执轮那一条的**归属判据**也升级过了：`adjustVerdict.approved` 循环里的
   * `executeAdjust` 由 `dispatchOwnershipProblems` 用"计数 + 行区间"守着。
   */
});

/* -------------------------------------------------------------------------- */
/*  ④.4 `this` 不许被存进变量：别名 / 解构 / 括号取成员（t41 GRD-A1/A2/A3）        */
/* -------------------------------------------------------------------------- */

test('★★★ `this` 不许被存进变量，也不许括号取成员（别名/解构/类型断言后索引）', () => {
  /*
   * ## 为什么这一条比"某个方法多了一次调用"更值得单独守
   *
   * 下面这些形状**只改一行、不加新方法、不触发任何其它守卫**，却能让本文件里
   * 每一处按 `this.<方法>(` 的扫描同时瞎掉：
   * ```
   *   const self = this;                          self.executeOpen(decision);      ← GRD-A3
   *   const t = this as unknown as Record<…>;     t['executeOpen'](decision);      ← GRD-A2
   *   const { executeOpen } = this;               executeOpen(decision);           ← GRD-A1（t42 S2）
   *   this['execute' + 'Open'](decision);                                          ← 动态名
   * ```
   * 它们今天**一处都没有**（实测：裸 this 别名 0、解构 0、`this as` 0、`this[` 0）。
   * 也就是说，这条禁令**不改变任何现有代码**，只堵住"一行改动带走整份守卫"这条路。
   *
   * ⚠️ 若将来确有正当理由（例如要把 `this` 传给一个 helper），**不要放宽这条**：
   *   先在 `callSitesOf` 的 `aliases` 参数上登记别名（那条通路已经实现并有校准，
   *   见校准测试里的 `self.executeOpen()` 夹具），再在这里放行。
   */
  const problems = aliasProblems(AUTO_TRADER);
  assert.deepEqual(
    problems,
    [],
    '★★★ `autoTrader.ts` 里出现了 `this` 别名 / 解构 / 括号取成员：\n' +
      problems.map((p) => `      · ${p}`).join('\n') +
      '\n    ⚠️ 这几种形状会让本守卫**全部**按名字的扫描一起失效（"少报"到"零报"）。\n' +
      '    ✅ 直接写 `this.xxx(…)`；确有正当理由时先登记别名（`callSitesOf` 已支持解析）。',
  );

  /*
   * ⚠️ 校准：这条判据必须真的能报出那三种形状，且**不许误报**折行的链式调用
   * （`const live = await this.deps.broker\n  .getOrder(…)` 在本仓库真实存在 3 处）。
   */
  const CAL_ALIAS = 'class Fake {\n  run() { const self = this; self.executeOpen(); }\n}';
  const CAL_DESTRUCTURE = 'class Fake {\n  run() { const { executeOpen } = this; executeOpen(); }\n}';
  const CAL_ASSERT = "class Fake {\n  run() { const t = this as unknown as Record<string, unknown>; t['executeOpen'](); }\n}";
  const CAL_BRACKET = "class Fake {\n  run() { this['execute' + 'Open'](); }\n}";
  const CAL_CHAINED = 'class Fake {\n  async run() { const live = await this.deps.broker\n    .getOrder(s, id); return live; }\n}';
  assert.ok(aliasProblems(CAL_ALIAS).some((p) => p.includes('self = this')), '★★★ 校准：`const self = this` 没被报出');
  assert.ok(aliasProblems(CAL_DESTRUCTURE).some((p) => p.includes('解构')), '★★★ 校准：从 this 解构没被报出');
  assert.ok(aliasProblems(CAL_ASSERT).some((p) => p.includes('t = this')), '★★★ 校准：类型断言后的别名没被报出');
  assert.ok(
    aliasProblems(CAL_ASSERT).some((p) => p.includes('括号取成员')),
    '★★★ 校准：`t[「executeOpen」]` 这种索引取成员没被报出',
  );
  assert.ok(aliasProblems(CAL_BRACKET).some((p) => p.includes('括号取成员')), '★★★ 校准：`this[…]` 没被报出');
  assert.deepEqual(
    aliasProblems(CAL_CHAINED),
    [],
    '★★ 折行的链式调用（`this.deps.broker\\n  .getOrder(…)`）不该被误判成别名',
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
/*  ⑤ 下单端点：只有适配器能打（含字面量/拼接前缀）                              */
/* -------------------------------------------------------------------------- */

/** 一份待扫描的源码（`rel` 是相对 `packages/server/src` 的 POSIX 路径）。 */
interface SourceFile {
  rel: string;
  /** ⚠️ 必须是 `plainCode(raw, /* keepStrings *\/ true)` 的结果 —— 端点是**字符串字面量**。 */
  code: string;
}

/**
 * 允许出现"下单端点字面量"的文件 —— **显式登记，附理由**。
 *
 * ## 为什么端点守卫要管到"字面量"，而不只是"谁发了请求"（t42 `S3`）
 *
 * 旧判据要求**方法名与端点字面量紧邻**（`signedRequest('POST', '/fapi/v1/order'`），
 * 于是下面这些写法一律看不见：
 * ```
 *   await fetch(BASE + '/fapi/v1/order', { … });        ← 没有 signedRequest 紧邻
 *   const path = '/fapi/v1/' + 'order';                 ← 拼接式路径
 *   const url = '/fapi/v1/order'; await http.post(url); ← 名字在变量里
 * ```
 * 现在的判据从"怎么发"退回到"**这个名字出现在哪**"：端点的字面量/前缀
 * 只许出现在登记过的文件里 —— 那是一条**更低、更难绕过**的门槛。
 *
 * ⚠️ 登记一条 = 承认"这个文件里会写端点名"。写日志文案也算，但必须写清理由。
 */
const ENDPOINT_LITERAL_ALLOWED: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'binance/broker.ts',
    why: '**唯一的适配器**：下单/撤单请求只由它发出（`placeStandardOrder` / `placeAlgoOrder`）。',
  },
  {
    file: 'scripts/liveSmokeTest.ts',
    why: '只把端点名写进**日志文案**（人工确认过的冒烟脚本），它不构造请求 —— 走的是 `broker` 的方法。',
  },
];

/** 下单/撤单系列的端点名（`/fapi/v1/<这些>` 就是"能改交易所状态"的那一族）。 */
const ORDER_ENDPOINT_FAMILY = 'order|algoOrder|allOpenOrders|algoOpenOrders';

/** 请求上下文的关键词：端点名与它们同一条语句时，说明这个文件真的在发请求。 */
const REQUEST_CONTEXT = /\b(?:fetch|signedRequest|request|axios|http\.(?:get|post|delete|put))\b/;

/**
 * 端点字面量的判据（纯函数，可被人造源码校准）。
 *
 * 三条：
 *   ① 任何一个 `/fapi/v1/<下单族>` **字面量**都必须落在登记文件里；
 *   ② `/fapi/v1/` 这个**前缀**（拼接式路径的兜底）也不许出现在未登记的文件里；
 *   ③ 端点字面量若与请求上下文（`fetch`/`signedRequest`/…）在同一语句里，
 *      那个文件必须是登记文件 —— 这条防的是"以后有人新写一个发请求的地方，
 *      顺手把端点名抄过去"（旧判据看不见这种）。
 */
function endpointLiteralProblems(files: readonly SourceFile[]): string[] {
  const allowed = new Set(ENDPOINT_LITERAL_ALLOWED.map((a) => a.file));
  const problems: string[] = [];
  const literalRe = new RegExp(`/fapi/v1/(?:${ORDER_ENDPOINT_FAMILY})\\b`, 'g');

  for (const file of files) {
    if (allowed.has(file.rel)) continue;
    for (const m of file.code.matchAll(literalRe)) {
      const line = lineAt(file.code, m.index ?? 0);
      const statement = statementAround(file.code, m.index ?? 0);
      const requestish = REQUEST_CONTEXT.test(statement);
      problems.push(
        `第 ${line} 行：${file.rel} 里出现了下单端点字面量 \`${m[0]}\`` +
          (requestish ? '（**且处于请求上下文里**）' : '（只是字面量，但也没登记）') +
          ' —— 端点的字面量只许出现在登记文件里（见 ENDPOINT_LITERAL_ALLOWED）',
      );
    }
    /*
     * ② 拼接兜底：`'/fapi/v1/' + 'order'` 这种写法**没有任何一处完整的端点名**，
     *    但它必然把 `/fapi/v1/` 这个前缀**拿去拼接** —— 所以盯"前缀出现在拼接里"。
     *
     * ⚠️ **不能退化成"任何 `/fapi/v1/` 前缀都不许出现"**（第一版就是这么写的，当场误报 5 个文件）：
     *    `binance/` 下还有一大批**只读**端点（klines / income / ws 订阅…），
     *    它们用同一个前缀、与"能不能改交易所状态"无关。判据必须钉在**下单族**上。
     */
    const concatHits = [
      ...file.code.matchAll(/\/fapi\/v1\/['"`]\s*\+|\+\s*['"`]\/fapi\/v1\//g),
    ].map((m) => lineAt(file.code, m.index ?? 0));
    if (concatHits.length > 0) {
      problems.push(
        `第 ${concatHits[0]} 行：${file.rel} 把 \`/fapi/v1/\` 前缀与别的内容**拼接**` +
          `（${concatHits.length} 处）—— 拼接式路径也不能绕开登记表`,
      );
    }
  }
  return problems;
}

/** 取 `index` 所在的那条语句（粗略：往前找到最近的 `;`/`{`/`}`，往后取 160 字符）。 */
function statementAround(code: string, index: number): string {
  let start = index;
  while (start > 0 && !/[;{}]/.test(code[start - 1] as string)) start -= 1;
  return code.slice(start, index + 160);
}

test('★★★ 下单 HTTP 端点只有 binance/broker.ts 能打：字面量登记 + 请求上下文 + POST 计数', () => {
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

  const files: SourceFile[] = [];
  for (const file of walk(SERVER_SRC)) {
    const rel = file.slice(SERVER_SRC.length + 1).replace(/\\/g, '/');
    /*
     * ⚠️ `keepStrings = true`：这条守卫查的是**端点名字面量**（`'/fapi/v1/order'`），
     * 而 `plainCode` 默认会把字符串内容抹掉 —— 那样这里会一条都查不到，
     * 表现为"零个越权调用"（实测踩到：计数从 1 变成 0）。
     */
    files.push({ rel, code: plainCode(readFileSync(file, 'utf8'), true) });
  }

  /* --- ③ 端点字面量 / 前缀只许出现在登记文件里（t42 S3） --- */
  const literalProblems = endpointLiteralProblems(files);
  assert.deepEqual(
    literalProblems,
    [],
    '★★★ 下单端点的字面量出现在未登记的文件里：\n' +
      literalProblems.map((p) => `      · ${p}`).join('\n') +
      '\n    适配器（`binance/broker.ts`）是**唯一**同时知道合约过滤器、又在下单路径上的层；' +
      '在别处拼路径打端点等于绕过它的归一化与预检（历史上因此吃过 `-1111` / `-4164`）。',
  );
  /* 非空性：登记表必须有内容，且扫描必须真的看到那个适配器。 */
  assert.ok(ENDPOINT_LITERAL_ALLOWED.length >= 1, '★ 端点登记表空了 —— 判据会退化成"哪里都不许出现"');
  assert.ok(
    files.some((f) => f.rel === 'binance/broker.ts' && new RegExp(`/fapi/v1/${ORDER_ENDPOINTS}`).test(f.code)),
    '★ 扫描没有看到适配器里的端点字面量 —— 口径失效',
  );

  /* --- 旧判据（保留）：谁在紧邻地发请求 + POST 恰好各一处 --- */
  const offenders: string[] = [];
  let postOrder = 0;
  let postAlgo = 0;
  for (const { rel, code } of files) {
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

  /*
   * --- ④ 校准：字面量判据必须报出"拼接式路径 / 别处发请求"，且不许误报登记过的两处 ---
   *（夹具是 t42 `S3` 点名的两种形状。）
   */
  const EVIL_FETCH: SourceFile[] = [
    { rel: 'trader/evil.ts', code: plainCode("export async function x() { await fetch(BASE + '/fapi/v1/order', {}); }", true) },
  ];
  const EVIL_CONCAT: SourceFile[] = [
    { rel: 'trader/evil2.ts', code: plainCode("const path = '/fapi/v1/' + 'order';", true) },
  ];
  const OK_BROKER: SourceFile[] = [
    { rel: 'binance/broker.ts', code: plainCode("await this.rest.signedRequest('POST', '/fapi/v1/order', {});", true) },
  ];
  const OK_SMOKE: SourceFile[] = [
    { rel: 'scripts/liveSmokeTest.ts', code: plainCode('info(`（走的是 /fapi/v1/order）`);', true) },
  ];
  assert.ok(
    endpointLiteralProblems(EVIL_FETCH).some((p) => p.includes('请求上下文')),
    '★★★ 校准：`fetch(BASE + \'/fapi/v1/order\')`（不与 signedRequest 紧邻）没被报出 —— 旧判据正是这里漏',
  );
  assert.ok(
    endpointLiteralProblems(EVIL_CONCAT).some((p) => p.includes('拼接式路径')),
    '★★★ 校准：`\'/fapi/v1/\' + \'order\'` 这种拼接没被报出',
  );
  assert.deepEqual(endpointLiteralProblems(OK_BROKER), [], '★★ 登记过的适配器不该被误报');
  assert.deepEqual(
    endpointLiteralProblems(OK_SMOKE),
    [],
    '★★ 登记过的冒烟脚本（只写日志文案）不该被误报',
  );
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

  /* ======================================================================== */
  /*  ⑦⑧⑨ t57：把 t41/t42 的**原始变异**逐个重放（在内存里改真实源码，不碰文件）  */
  /* ======================================================================== */

  /*
   * 重放用的手术刀：在**真实源码文本**上插一行/换一段，然后跑与生产完全相同的判据。
   * ⚠️ 全部在内存里 —— 不写文件、不碰业务代码（本任务的硬边界）。
   */
  const inject = (src: string, anchor: string, text: string): string => src.replace(anchor, `${text}\n${anchor}`);
  const mustChange = (after: string, before: string, label: string): void => {
    assert.notEqual(after, before, `★ 变异「${label}」没有生效（锚点文本变了？）`);
  };

  /* --- ⑦ `GRD-A3`（t41/t42 S2 最锋利的那条）：`const self = this; self.executeOpen(…)` --- */
  const A3_MUTATED_RAW = inject(
    AUTO_TRADER_RAW,
    '  private async executeOpen(',
    '  private async t57AliasEntry(decision: Decision): Promise<void> {\n' +
      '    const self = this;\n' +
      '    await self.executeOpen(decision, undefined);\n' +
      '  }',
  );
  mustChange(A3_MUTATED_RAW, AUTO_TRADER_RAW, 'GRD-A3 别名 this');
  const A3_CODE = plainCode(A3_MUTATED_RAW);
  assert.ok(
    aliasProblems(A3_CODE).some((p) => p.includes('self = this')),
    '★★★ 重放 GRD-A3：`const self = this; self.executeOpen(…)` 必须被报出（改前 exit=0）',
  );
  /*
   * 而且**即使别名被登记放行**，`callSitesOf` 解析别名后也必须把这次调用归到
   * `t57AliasEntry` 上 —— 那是"扩大覆盖面"的第二层：不是只喊"禁止别名"，
   * 而是真的**看得见**别名上的调用（登记通路有校准才可信）。
   */
  const A3_ALIAS_NAMES = thisAliasesOf(A3_CODE).filter((a) => a.how === 'alias').map((a) => a.name);
  assert.ok(A3_ALIAS_NAMES.includes('self'), '★ 别名解析没有认出 `self`');
  const a3Cal = callerProblems(A3_CODE, membersOf(A3_CODE), CALLERS, A3_ALIAS_NAMES);
  assert.ok(
    a3Cal.offenders.some((o) => o.includes('t57AliasEntry')),
    '★★★ 重放 GRD-A3：别名上的 `self.executeOpen(…)` 必须被"调用者穷举"报出（改前它完全看不见）',
  );

  /* --- ⑧ `GRD-A2`：类型断言后索引 `const t = this as …; t['executeOpen'](…)` --- */
  const A2_MUTATED_RAW = inject(
    AUTO_TRADER_RAW,
    '  private async executeOpen(',
    '  private async t57AssertEntry(decision: Decision): Promise<void> {\n' +
      '    const t = this as unknown as Record<string, (d: Decision) => Promise<void>>;\n' +
      "    await t['executeOpen'](decision);\n" +
      '  }',
  );
  mustChange(A2_MUTATED_RAW, AUTO_TRADER_RAW, 'GRD-A2 类型断言后索引');
  const a2Problems = aliasProblems(plainCode(A2_MUTATED_RAW));
  assert.ok(
    a2Problems.some((p) => p.includes('t = this')),
    '★★★ 重放 GRD-A2：类型断言出来的 `this` 别名必须被报出（改前 exit=0）',
  );
  assert.ok(
    a2Problems.some((p) => p.includes('括号取成员')),
    '★★★ 重放 GRD-A2：`t[「executeOpen」]` 这种索引取成员必须被报出（改前 exit=0）',
  );

  /* --- ⑨ `GRD-A1`（t42 S2）：从 this 解构方法引用 --- */
  const A1_MUTATED_RAW = inject(
    AUTO_TRADER_RAW,
    '  private async executeOpen(',
    '  private async t57DestructuredEntry(decision: Decision): Promise<void> {\n' +
      '    const { executeOpen } = this;\n' +
      '    await executeOpen(decision, undefined);\n' +
      '  }',
  );
  mustChange(A1_MUTATED_RAW, AUTO_TRADER_RAW, 'GRD-A1 解构方法引用');
  assert.ok(
    aliasProblems(plainCode(A1_MUTATED_RAW)).some((p) => p.includes('解构')),
    '★★★ 重放 GRD-A1/t42 S2：`const { executeOpen } = this` 必须被报出（改前 exit=0）',
  );

  /* --- ⑩ `GRD-B1`：把分派插进 runCycleBody（循环之外），同时保留循环里那一处 --- */
  const LOOP_LINE = '    for (const decision of verdict.approved) {';
  const B1_MUTATED_RAW = inject(
    AUTO_TRADER_RAW,
    LOOP_LINE,
    '    if (this.t57OpportunisticFlag) {\n' +
      '      await this.executeOpen({ symbol: "BTCUSDT" } as never, undefined);\n' +
      '    }',
  );
  mustChange(B1_MUTATED_RAW, AUTO_TRADER_RAW, 'GRD-B1 循环外分派');
  const b1Problems = dispatchOwnershipProblems(plainCode(B1_MUTATED_RAW));
  assert.ok(
    b1Problems.some((p) => p.includes('executeOpen') && p.includes('2 处')),
    '★★★ 重放 GRD-B1：runCycleBody 里出现第二处 `executeOpen` 必须被报出（旧判据只做存在性检查，因此 exit=0）',
  );
  /*
   * 第二个重放：**把循环里那一处挪到循环之外**（另一分支形态）——
   * 此时 `runCycleBody` 里仍然"恰好 1 处"，所以**只有行区间归属能抓住它**：
   * 旧判据（`loopBody.includes`）与"计数"判据在这里都是 exit=0。
   */
  const B1_MOVED_RAW = AUTO_TRADER_RAW.replace(
    '          const outcome = await this.executeOpen(decision, snapshotBySymbol.get(decision.symbol));',
    '          // t57 校准：把这一处分派挪到循环之外',
  ).replace(
    LOOP_LINE,
    '    if (this.t57SecondPath) {\n      await this.executeOpen({ symbol: "TIAUSDT" } as never, undefined);\n    }\n' + LOOP_LINE,
  );
  mustChange(B1_MOVED_RAW, AUTO_TRADER_RAW, 'GRD-B1 分派挪到循环之外');
  const b1Moved = dispatchOwnershipProblems(plainCode(B1_MOVED_RAW));
  assert.ok(
    b1Moved.some((p) => p.includes('executeOpen') && p.includes('之外')),
    '★★★ 重放 GRD-B1（第二形态）：分派落在循环**之外**必须被"行区间归属"报出（旧判据与计数判据都看不见）',
  );

  /* --- ⑪ `S3`：端点字面量的两种绕法（已在上一条测试里校准，这里再钉一次"改前看不见"） --- */
  const S3_FILES: SourceFile[] = [
    {
      rel: 'trader/t57Endpoints.ts',
      code: plainCode("export const p = BASE + '/fapi/v1/order'; fetch(p);", true),
    },
  ];
  assert.ok(
    endpointLiteralProblems(S3_FILES).length > 0,
    '★★★ 重放 t42 S3：拼接式的下单端点路径必须被报出（改前它与 signedRequest 不紧邻 → exit=0）',
  );

  /* 收尾：四处重放**全部在真实源码的副本上**做过，而真实文件一个字节都没动（见下方断言）。 */
  assert.equal(
    AUTO_TRADER_RAW,
    readFileSync(new URL('./autoTrader.ts', import.meta.url), 'utf8'),
    '★★★ 校准过程不许改到真实文件 —— 这里的重放必须发生在内存副本上',
  );
});

/* -------------------------------------------------------------------------- */
/*  ⑥.5 改前 vs 改后：同一个变异，旧判据看不见、新判据必须红                       */
/* -------------------------------------------------------------------------- */

/**
 * **这条测试的存在理由**（t57）：`t41`/`t42` 指出的四个缺口都是"**少报**"——
 * 今天没有坏代码被放行，但**未来的一行改动会静默通过**。
 *
 * 于是"改后能红"这个证据必须成对出现，否则它证明不了任何东西：
 * ```
 *   ✗ 只证明"新判据报出了变异" → 可能旧判据本来也会报（那这个补丁多余）
 *   ✓ 同时证明"旧判据在同一变异上一条都不报" → 补丁真的补上了那个缺口
 * ```
 *
 * ⚠️ 这里**故意把旧判据原样重写一遍**（而不是从 git 取 HEAD 的文件）：
 * 从 git 取会让这条测试依赖工作树之外的提交历史（"测试读 git"是个坏味道，
 * 而且 rebase/浅克隆会把它弄坏）。旧判据的形态在下面每条里都写清楚了，
 * 它们与 `t41`/`t42` 描述的形状一一对应。
 */
test('★★★ 改前看不见、改后必须红：四个缺口的旧判据 vs 新判据（同一变异）', () => {
  const inject = (src: string, anchor: string, text: string): string => src.replace(anchor, `${text}\n${anchor}`);
  const LOOP_LINE = '    for (const decision of verdict.approved) {';

  /* ---------------- 缺口 A（GRD-A3）：别名 `this` ---------------- */
  const A_MUTATED = inject(
    AUTO_TRADER_RAW,
    '  private async executeOpen(',
    '  private async t57AliasEntry(decision: Decision): Promise<void> {\n' +
      '    const self = this;\n' +
      '    await self.executeOpen(decision, undefined);\n' +
      '  }',
  );
  assert.notEqual(A_MUTATED, AUTO_TRADER_RAW, '★ 变异没生效');
  const A_CODE = plainCode(A_MUTATED);

  /* 旧判据：`callSitesOf` 只认 `this.<name>(`（t41 报告里的原话）。 */
  const OLD_SCAN = /this\s*\.\s*executeOpen\s*\(/g;
  assert.equal(
    (A_CODE.match(OLD_SCAN) ?? []).length,
    (AUTO_TRADER.match(OLD_SCAN) ?? []).length,
    '★★ 旧判据（只认 `this.` 前缀）本该**完全看不见**别名上的调用 —— 它看见了说明我对旧判据的复述错了',
  );
  const oldCallers = callerProblems(A_CODE, membersOf(A_CODE), CALLERS); /* 不传别名 = 旧行为 */
  assert.equal(
    oldCallers.offenders.length,
    0,
    '★★ 旧判据在 `const self = this; self.executeOpen(…)` 上是 **exit=0** —— 这正是 GRD-A3 那条缺口',
  );

  /* 新判据：两道都要红（禁止别名 + 别名解析后归到调用者）。 */
  assert.ok(aliasProblems(A_CODE).length > 0, '★★★ 改后：别名必须被禁止（红灯）');
  const newCallers = callerProblems(
    A_CODE,
    membersOf(A_CODE),
    CALLERS,
    thisAliasesOf(A_CODE).filter((a) => a.how === 'alias').map((a) => a.name),
  );
  assert.ok(
    newCallers.offenders.some((o) => o.includes('t57AliasEntry')),
    '★★★ 改后：别名解析必须把这处调用归到 `t57AliasEntry`（红灯）',
  );

  /* ---------------- 缺口 B（GRD-B1）：循环之外多一条执行路径 ---------------- */
  /*
   * ⚠️ 这里必须把两种形态分清楚，否则会把"精度提升"说成"覆盖面扩大"：
   *
   *   B1-a **保留**循环里那一处、**另加**一处到循环之外 → 旧判据（存在性）**完全瞎**（真正的缺口）
   *   B1-b **把**循环里那一处**挪走**（循环里没有了）        → 旧判据会报"缺了"（不是瞎，是说不清位置）
   *
   * 新判据（计数 + 行区间）对两种形态都给出**准确**结论：前者报"2 处"，后者报"落在循环之外"。
   */
  const B1A_MUTATED = inject(
    AUTO_TRADER_RAW,
    LOOP_LINE,
    '    if (this.t57SecondPath) {\n      await this.executeOpen({ symbol: "TIAUSDT" } as never, undefined);\n    }',
  );
  assert.notEqual(B1A_MUTATED, AUTO_TRADER_RAW, '★ 变异 B1-a 没生效');
  const B1A_CODE = plainCode(B1A_MUTATED);
  const b1aLoopAt = B1A_CODE.indexOf(APPROVED_LOOP_NEEDLE);
  const b1aLoopBody = balancedFrom(B1A_CODE, b1aLoopAt + APPROVED_LOOP_NEEDLE.length - 1);

  /* 旧判据：`loopBody.includes('this.executeOpen(')` —— 循环里那一处还在，所以它一条都不报。 */
  const OLD_NEEDLES = DISPATCH_METHODS.map((m) => `this.${m}(`);
  const oldMissingB1a = OLD_NEEDLES.filter((n) => !b1aLoopBody.includes(n));
  assert.deepEqual(
    oldMissingB1a,
    [],
    '★★ 旧判据（存在性）在"循环里保留、循环外另加一条"上是 **exit=0** —— 这正是 GRD-B1 的缺口形状',
  );
  /* 新判据：计数必须报"2 处"。 */
  assert.ok(
    dispatchOwnershipProblems(B1A_CODE).some((p) => p.includes('executeOpen') && p.includes('2 处')),
    '★★★ 改后：runCycleBody 里出现第二处 executeOpen 必须被"计数"报出（红灯）',
  );

  /* B1-b：把循环里那一处挪到循环之外 —— 旧判据会报"缺了"，但说不清它**在哪**。 */
  const B1B_MUTATED = AUTO_TRADER_RAW.replace(
    '          const outcome = await this.executeOpen(decision, snapshotBySymbol.get(decision.symbol));',
    '          // t57 校准：把这一处分派挪到循环之外',
  ).replace(
    LOOP_LINE,
    '    if (this.t57MovedPath) {\n      await this.executeOpen({ symbol: "TIAUSDT" } as never, undefined);\n    }\n' + LOOP_LINE,
  );
  assert.notEqual(B1B_MUTATED, AUTO_TRADER_RAW, '★ 变异 B1-b 没生效（锚点文本变了？）');
  const B1B_CODE = plainCode(B1B_MUTATED);
  const b1bLoopBody = balancedFrom(
    B1B_CODE,
    B1B_CODE.indexOf(APPROVED_LOOP_NEEDLE) + APPROVED_LOOP_NEEDLE.length - 1,
  );
  assert.equal(
    b1bLoopBody.includes('this.executeOpen('),
    false,
    '★ 变异 B1-b 没做到位 —— 循环里那一处应当已经被挪走（否则这条对照说明不了什么）',
  );
  assert.ok(
    dispatchOwnershipProblems(B1B_CODE).some((p) => p.includes('executeOpen') && p.includes('之外')),
    '★★★ 改后：分派落在循环之外必须被"行区间归属"报出（旧判据只能说"缺了"，说不出它在哪里）',
  );

  /* ---------------- 缺口 C（GRD-A2）：类型断言后索引 ---------------- */
  const C_MUTATED = inject(
    AUTO_TRADER_RAW,
    '  private async executeOpen(',
    '  private async t57AssertEntry(decision: Decision): Promise<void> {\n' +
      '    const t = this as unknown as Record<string, (d: Decision) => Promise<void>>;\n' +
      "    await t['executeOpen'](decision);\n" +
      '  }',
  );
  assert.notEqual(C_MUTATED, AUTO_TRADER_RAW, '★ 变异没生效');
  const C_CODE = plainCode(C_MUTATED);
  /* 旧判据：唯一相关的是"禁止 `this[`"这一条 —— 而它在 `as …)` 之后，看不见。 */
  assert.equal(
    (C_CODE.match(/this\[/g) ?? []).length,
    0,
    '★★ 旧判据（`this[` 计数）在类型断言 + 索引这条形状上是 **exit=0** —— 这正是 GRD-A2',
  );
  assert.ok(
    aliasProblems(C_CODE).some((p) => p.includes('括号取成员')),
    '★★★ 改后：`t[「executeOpen」]` 必须被报出（红灯）',
  );

  /* ---------------- 缺口 D（t42 S3）：拼接式下单端点 ---------------- */
  const D_FILE: SourceFile = {
    rel: 'trader/t57Endpoints.ts',
    code: plainCode("export async function go() { await fetch(BASE + '/fapi/v1/order', {}); }", true),
  };
  /* 旧判据：要求 `signedRequest('POST', '/fapi/v1/order'` **紧邻**。 */
  const OLD_ENDPOINT = /signedRequest(?:<[^>]*>)?\(\s*['"](?:POST|DELETE|PUT)['"]\s*,\s*['"]\/fapi\/v1\/(?:order|algoOrder|allOpenOrders|algoOpenOrders)['"]/;
  assert.equal(
    (D_FILE.code.match(OLD_ENDPOINT) ?? []).length,
    0,
    '★★ 旧判据（要求端点与 signedRequest 紧邻）在拼接式路径上是 **exit=0** —— 这正是 t42 S3',
  );
  assert.ok(endpointLiteralProblems([D_FILE]).length > 0, '★★★ 改后：拼接式下单端点必须被报出（红灯）');
});

/* -------------------------------------------------------------------------- */
/*  ⑦ 元守卫：禁止恒真断言（本仓库已有一条这样失效的守卫）                        */
/* -------------------------------------------------------------------------- */

/**
 * 已知的恒真断言。**这是一张"待还的债"清单，不是一个白名单** ——
 * 里面每一条都必须由某个任务承接修复，修好后把这一行删掉（本守卫不需要同步改）。
 *
 * ## 现在是空的（2026-10-17，t43 已还清）
 *
 * 唯一一条是 `trader/agent/perSymbolWiring.test.ts` 里那条"左半句等于 false
 * **再接一个恒真的尾巴**"的断言（整条恒真、守卫从未生效）。t43 已把它改成
 * **独立的、可失败的判据**，并从本表移除 —— 于是本守卫现在会**真的扫那个文件**。
 * （⚠️ 这里刻意不把那半句吞掉判据的字面量抄一遍：抄一遍又会被裸 grep 当成一处新的恒真形状。）
 *
 * ⚠️ 这张表留着的意义：下一次出现恒真断言时，把它记在这里**只是登记债务**
 * （带上下承接它的任务），而不是放行 —— 否则"豁免"会变成永久的白名单。
 */
const KNOWN_VACUOUS: ReadonlyArray<{ file: string; why: string }> = [];

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
      '\n    ⚠️ 本仓库已经有过一次真实教训：`trader/agent/perSymbolWiring.test.ts` 曾用' +
      '"左半句比 false 再接一个恒真尾巴"的形状让整条用例永远为真（**t43 已修**，' +
      '豁免表因此清空 —— 所以现在这个文件也在被本守卫真扫）。\n' +
      '    ✅ 修法：把左侧那半句写成**独立的 `assert`**（它本来就是想断言"只应有一处"）。',
  );
});
