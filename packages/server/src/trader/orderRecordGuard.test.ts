/**
 * **每一笔下到交易所的订单都必须落库**（五道闸门的第 ② 条不变量之一）。
 *
 * ## 这条守卫接的是什么
 *
 * `autoTrader.ts` 里 `recordOrder` 的注释写着它是
 * 「**所有下单路径的唯一落库口**（开仓、平仓、止损、止盈、…）」。
 *
 * ⚠️ 但"每一处下单都记得调它"是**靠人逐个记**的 —— 而这个仓库已经因此**漏过两次**
 *（`autoTrader.test.ts` 里留着记录）：
 *
 * ```
 * ① 加仓单（executeAdd）：算出了 exitFee、写进了成交表、改了持仓，
 *    却没有 recordOrder → 订单列表里永远看不到加仓单，而它是一笔有真实手续费的成交。
 * ② 限价立即成交（submitLimitEntry）：recordOrder 与 pending 插入都在 `return` 之后，
 *    → 那张已经成交的 LIMIT 单永远没有账。
 * ```
 *
 * ⚠️ 两次的共同形态：**代码是对的，只是那一条路径漏了记录** ——
 * 不报错、不进日志，只是"这笔单在界面上不存在"。
 * 而"订单列表里少一笔"对账时就是**凭空多出来的差额**。
 *
 * ## 判据：**按函数体**配对，不是按行数窗口
 *
 * 对每个"会下单"的方法（体内出现 `broker.placeOrder(`）：
 * 断言它体内**也出现** `this.recordOrder(`，且**次数不少于**下单次数。
 *
 * ⚠️ 我第一版用"下单点之后 130 行内有没有 recordOrder"扫 —— 结果 7/7 全绿。
 * **但那个判据是脆的**：它依赖"记录语句恰好写在附近"，而两个真实事故
 * （`executeAdd`、`submitLimitEntry`）**恰恰是"写在了 return 之后"** ——
 * 那种情况下"附近有"与"会执行"是两回事。
 *
 * ⚠️ 而"按函数体配对"仍然**不能证明"每条分支都会执行它"**（那需要控制流分析）——
 * 这条边界写在下面，别把它当成比它更强的保证。
 *
 * ## 边界（诚实说明）
 *
 * · 它只保证"**这个方法体内有记录语句**"，不保证"**每条 return 之前都有**"；
 * · 它抓不住"在别的文件里下单"（例如新增一个 broker 封装）——
 *   那需要另一种守卫（"所有 `broker.placeOrder` 只出现在 `autoTrader.ts`"）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

interface Method {
  name: string;
  startLine: number;
  body: string;
}

/**
 * 取出 `AutoTrader` 里所有**方法级**的函数体。
 *
 * ⚠️ 用"缩进两格的成员声明"当边界 —— 与 `receiptAdjustGate.test.ts` 同一手法。
 */
function methods(): Method[] {
  const lines = CODE.split('\n');
  const out: Method[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([a-zA-Z_$][\w$]*)\s*[(<]/.exec(
      lines[i] ?? '',
    );
    if (!m) continue;
    const name = m[1]!;
    /* 边界：下一个同级成员声明（缩进两格的方法/属性）。 */
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^ {2}(?:private |public |protected |static |async |readonly )*[a-zA-Z_$][\w$]*\s*[(<]/.test(lines[j] ?? '')) {
        end = j;
        break;
      }
      /* 也停在类结束。 */
      if (/^\}/.test(lines[j] ?? '')) {
        end = j;
        break;
      }
    }
    out.push({ name, startLine: i + 1, body: lines.slice(i, end).join('\n') });
  }
  return out;
}

test('★★★ 每一处下单都必须有对应的落库（recordOrder）—— 订单不许"在界面上不存在"', () => {
  const all = methods();

  /* 前置断言：必须真的解析出方法（否则"零个问题"是因为没解析到东西）。 */
  assert.ok(all.length >= 20, `★ 只解析出 ${all.length} 个方法 —— 解析可能失效了`);

  const orderPlacing = all.filter((m) => /broker\.placeOrder\(/.test(m.body));
  assert.ok(
    orderPlacing.length >= 5,
    `★ 只找到 ${orderPlacing.length} 个"会下单"的方法 —— 扫描可能失效了`,
  );

  const unpaired: string[] = [];
  for (const m of orderPlacing) {
    const places = (m.body.match(/broker\.placeOrder\(/g) ?? []).length;
    const records = (m.body.match(/this\.recordOrder\(/g) ?? []).length;
    if (records < places) {
      unpaired.push(`${m.name}（第 ${m.startLine} 行）：下单 ${places} 次，落库只有 ${records} 次`);
    }
  }

  assert.deepEqual(
    unpaired,
    [],
    '★★★ 这些方法**下单了却没有落库**（或落库次数少于下单次数）：\n' +
      unpaired.map((u) => `      · ${u}`).join('\n') +
      '\n    ⚠️ 这是五道闸门的第 ② 条不变量：「**每一笔订单都必须被记录**」。\n' +
      '    这个仓库已经因此漏过**两次**（`autoTrader.test.ts` 里留着记录）：\n' +
      '      · 加仓单（`executeAdd`）—— 订单列表里永远看不到它；\n' +
      '      · 限价立即成交（`submitLimitEntry`）—— `recordOrder` 在 `return` 之后，永不执行。\n' +
      '    ⚠️ 两次都不报错、不进日志，只是"这笔单在界面上不存在" ——\n' +
      '    而"订单列表里少一笔"对账时就是**凭空多出来的差额**。\n' +
      '    ✅ 修法：把 `this.recordOrder({…})` 放在**任何 return 之前**。',
  );
});

test('★★★ 判据必须能真的报出漏落库 —— 用人造源码校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `unpaired` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑人造方法体，断言漏落库会被报出。
   */
  const pair = (body: string): boolean => {
    const places = (body.match(/broker\.placeOrder\(/g) ?? []).length;
    const records = (body.match(/this\.recordOrder\(/g) ?? []).length;
    return records >= places;
  };

  assert.equal(
    pair('const placed = await this.deps.broker.placeOrder({ … });'),
    false,
    '★★★ 判据必须能报出"下单了但没落库" —— 否则上面那条是在空转',
  );
  assert.equal(
    pair('const placed = await this.deps.broker.placeOrder({ … });\nthis.recordOrder({ … });'),
    true,
    '★★ 配对的不能被误报',
  );
  assert.equal(
    pair('const a = await this.deps.broker.placeOrder({});\nconst b = await this.deps.broker.placeOrder({});\nthis.recordOrder({});'),
    false,
    '★★ 下单两次只落库一次也要报（"次数不少于"是刻意的）',
  );
});

test('★★★ 所有下单都必须发生在 autoTrader.ts —— 别处不许直接调 broker.placeOrder', () => {
  /*
   * ⚠️ 上一条只在 `autoTrader.ts` 内配对。若**别的文件**也直接下单，
   * 它既不会被上一条看到，也几乎一定不会走 `recordOrder`。
   *
   * 判据：全仓非测试源码里，`broker.placeOrder(` / `.placeOrder(` 只允许出现在
   * `trader/autoTrader.ts`（以及 broker 自己的实现/接口）。
   */
  const serverSrc = (() => {
    const start = fileURLToPath(new URL('.', import.meta.url));
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const probe = join(dir, 'trader', 'autoTrader.ts');
      try {
        if (statSync(probe).isFile()) return dir;
      } catch {
        /* 继续往上。 */
      }
      dir = join(dir, '..');
    }
    throw new Error('找不到 packages/server/src');
  })();

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.ts$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };

  /** 允许出现 `.placeOrder(` 的文件 —— 显式登记，附理由。 */
  const ALLOWED = new Set([
    'trader/autoTrader.ts', // 唯一的调用方（且它自己必须配对 recordOrder，由上一条守着）
    'trader/broker.ts', // 接口声明（类型层面）
    'binance/broker.ts', // 实现（真正发请求的那一层）
    'simulate/simulatedExchange.ts', // 模拟盘的实现
    'scripts/demoCycle.ts', // 演示脚本里的**模拟 broker 实现**（不是"下单调用"）
    /*
     * ⚠️ `liveSmokeTest.ts` 是**刻意绕开 `autoTrader`** 的 —— 它的定位就是
     * 「**proves the order path works against the real exchange**」：
     * 只走 broker、不经决策链，才验得出"接线通不通"。
     *
     * ⚠️ 它因此**不落 `orders` 表**，也**不过风控** —— 这是**有意**的，
     * 不是漏了。而且它：
     *   · 必须显式带 `--confirm` 才跑（"Real money moves here"）；
     *   · 从 `finally` 块里清理（异常也会平掉）；
     *   · 有名义上限。
     *
     * ⚠️ **本仓库的红线明确禁止我（处理轮次的智能体）运行它** ——
     * 它是留给人在真机上手工执行的。所以这条豁免同时是一份**记录**：
     * "这个脚本不记账，且这是设计如此"。
     */
    'scripts/liveSmokeTest.ts',
  ]);

  const offenders: string[] = [];
  for (const file of walk(serverSrc)) {
    const rel = file.slice(serverSrc.length + 1).replace(/\\/g, '/');
    if (ALLOWED.has(rel)) continue;
    const code = stripCommentsKeepLines(readFileSync(file, 'utf8'));
    if (/\bplaceOrder\(/.test(code)) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些文件里出现了 `placeOrder(` ——\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ⚠️ 下单只能从 `trader/autoTrader.ts` 走（那里才有 `recordOrder`）。\n' +
      '    别处直接下单 = **既不过风控的落库口，也不记账**。\n' +
      '    ✅ 若确实是接口/实现层（类型声明或真正发请求的那一层），加进 `ALLOWED` 并写明理由。',
  );
});
