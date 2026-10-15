/**
 * **金额算术只能有一个实现**（`docs/COLLABORATION.md` §5.4）—— 净额算式不许再复制。
 *
 * ## 这条守卫接的是什么（有实测代价的先例）
 *
 * `binance/income.ts` 的 `netPnlOf` 注释里记着一次**真实的账目事故**：
 *
 * > 修之前，同一个算式在仓库里有**五处**副本（`repositories.ts` 两处、
 * > `autoTrader.ts` 三处），于是同一个符号错误也复制了五份。
 *
 * ⚠️ 那个符号错误是：`净 = 毛 − 手续费 − 资金费` 这个写法**只在一半情况下成立** ——
 * 它假设手续费与资金费是**正数**（支出），而交易所 `income` 拿到的是**负数**。
 * 于是 `− (−0.00718777)` 把**一笔支出加成了收入**。
 *
 * 实测代价（注释里记着）：`#9` 的总账校验**每轮都报一条假告警**，
 * 差额正好是资金费的两倍（`0.00718777 × 2 = 0.01437554`）。
 *
 * ⚠️ 所以"算式只有一处"不只是风格问题 —— **五处副本意味着改对一处等于没改**。
 *
 * ## 判据
 *
 * 扫 `packages/server/src` 的**非测试**源码，找出"**用 grossPnl 参与加减**"的表达式，
 * 断言它们只出现在白名单里。
 *
 * ⚠️ 白名单**必须显式登记并写明理由** —— 因为有两处是**合法的例外**：
 *
 * | 位置 | 为什么合法 |
 * | --- | --- |
 * | `binance/income.ts` | **唯一的实现**（`netPnlOf`）|
 * | `autoTrader.ts` 的部分平仓 | `grossPnl - exitFee` —— 那一笔的 `entryFee: 0`、`fundingFee: 0`，所以与 `netPnlOf` **等价**（注释已说明"本笔平仓净额"不含开仓费）|
 * | `db/schema.ts` 的迁移 | **一次性 backfill**（`M2_TRADE_ACCOUNTING`），不是活跃逻辑 |
 * | `simulate/simulatedExchange.ts` | 模拟盘自己的账（`pnl - fee`），**不走真实账本** |
 * | `trader/roundTrips.ts` | **累加**毛额（`+=`），不是算净额 |
 *
 * ⚠️ 豁免的理由必须写清是"**哪一种**合法"（唯一实现 / 等价 / 一次性 / 不走真实账本 / 不是净额）
 * —— 否则名单会变成垃圾桶。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** 从本文件定位 `packages/server/src`（按标记找，不猜相对层数）。 */
function findServerSrc(): string {
  const start = fileURLToPath(new URL('.', import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const probe = join(dir, 'src', 'binance', 'income.ts');
    try {
      if (statSync(probe).isFile()) return join(dir, 'src');
    } catch {
      /* 继续往上找。 */
    }
    dir = join(dir, '..');
  }
  throw new Error(`找不到 packages/server/src（从 ${start} 向上找了 8 层）`);
}

const SERVER_SRC = findServerSrc();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 剥注释但**保留行号**（报错位置必须与文件一致）。 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

/**
 * 允许出现"用 `grossPnl` 参与加减"的文件 —— **显式登记，附理由**。
 *
 * ⚠️ 键是**相对 `packages/server/src` 的路径**。
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ['binance/income.ts', '**唯一的实现**（`netPnlOf`）—— 其余地方都必须调它'],
  [
    'trader/autoTrader.ts',
    '部分平仓那一笔：`grossPnl - exitFee`。⚠️ 它的 `entryFee: 0`、`fundingFee: 0`，' +
      '所以与 `netPnlOf` **等价**（注释写明"本笔平仓净额"不含开仓费 —— 开仓费在开仓时已付）。' +
      '⚠️ 若将来这一笔开始带开仓费/资金费，**必须改调 `netPnlOf`**，否则这条豁免不成立。',
  ],
  [
    'db/schema.ts',
    '**一次性迁移的 backfill**（`M2_TRADE_ACCOUNTING` 里的 `UPDATE trades SET net_pnl = pnl - fee`）' +
      '—— 不是活跃逻辑，且注释说明"reconciliation pass 会修正"。',
  ],
  [
    'simulate/simulatedExchange.ts',
    '模拟盘自己的账（`pnl - fee`）—— 它**不走真实账本**，也不写 `trades` 表。',
  ],
  [
    'trader/roundTrips.ts',
    '**累加**毛额（`leg.grossPnl += …`）—— 是求和，不是算净额。',
  ],
]);

test('★★★ 净额算式只能有一个实现（§5.4）—— 不许再复制', () => {
  const files = walk(SERVER_SRC);
  const offenders: string[] = [];
  let checked = 0;

  for (const file of files) {
    const rel = file.slice(SERVER_SRC.length + 1).replace(/\\/g, '/');
    const code = stripCommentsKeepLines(readFileSync(file, 'utf8'));

    /*
     * 判据：`grossPnl` 出现在**加减表达式**里。
     * ⚠️ 只找 `grossPnl` 参与 `+` / `-` 的形状 —— 单纯的赋值（`grossPnl: x`）
     * 或比较不算"算净额"。
     */
    const hits = [...code.matchAll(/grossPnl\s*[-+]|[-+]\s*grossPnl\b|grossPnl\s*[-+]=/g)];
    if (hits.length === 0) continue;
    checked += hits.length;

    if (!ALLOWED.has(rel)) {
      for (const hit of hits) {
        const line = code.slice(0, hit.index).split('\n').length;
        offenders.push(`${rel}:${line}`);
      }
    }
  }

  /* 前置断言：必须真的扫到若干处（否则"零个问题"是因为没扫到东西）。 */
  assert.ok(
    checked >= 2,
    `★ 只扫到 ${checked} 处 \`grossPnl\` 参与加减的地方 —— 扫描可能失效了，那样这条什么都没验`,
  );

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些地方**又自己算了一遍净额**：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ⚠️ `docs/COLLABORATION.md` §5.4：金额相关的算术**只在一个地方算**。\n' +
      '    ⚠️ 这不是风格问题 —— 这个算式曾经有**五处副本**，于是同一个符号错误\n' +
      '    （资金费是负数，`− (−x)` 把支出加成收入）也复制了五份，\n' +
      '    代价是 `#9` 的总账校验**每轮报一条假告警**（差额正好是资金费的两倍）。\n' +
      '    ✅ 请改调 `netPnlOf({ grossPnl, fee, fundingFee })`（`binance/income.ts`）。\n' +
      '       若确实是合法例外（等价/一次性/模拟盘），加进 `ALLOWED` 并**写明是哪一种**。',
  );
});

test('★★★ 判据必须能真的报出重复算式 —— 用人造源码校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `offenders` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑一段**故意重复算式**的源码，断言它会被报出。
   */
  const scan = (code: string): string[] =>
    code
      .split('\n')
      .flatMap((line) => [...line.matchAll(/grossPnl\s*[-+]|[-+]\s*grossPnl\b|grossPnl\s*[-+]=/g)].map(() => 'hit'));

  assert.equal(
    scan('const net = grossPnl - fee + fundingFee;').length,
    1,
    '★★★ 判据必须能报出重复的净额算式 —— 否则上面那条是在空转',
  );
  assert.equal(
    scan('leg.grossPnl += Number(fill.realizedPnl) || 0;').length,
    1,
    '★ 累加毛额也算（它由 ALLOWED 豁免，不是漏判）',
  );
  assert.equal(
    scan('const net = netPnlOf({ grossPnl, fee, fundingFee });').length,
    0,
    '★★ 调用唯一实现的不该被误报（参数里的 `grossPnl` 没有参与加减）',
  );
});

test('★★ `netPnlOf` 的符号约定必须与交易所 income 一致 —— 资金费是负数', () => {
  /*
   * ⚠️ 这条钉住的是**那个符号错误本身**（不只是"只有一处实现"）。
   * 交易所 `income` 的 `fundingFee`：**支出为负、收入为正**。
   * 所以净额必须是 `毛 − 手续费 + 资金费`（**加**，因为负数已经是"减"）。
   */
  const code = readFileSync(join(SERVER_SRC, 'binance', 'income.ts'), 'utf8');
  /*
   * ⚠️ 不能切到第一个 `\n}` —— 参数类型里的 `}` 会先命中（我第一版就栽在这，
   * 断言拿到的是函数**签名**而不是**函数体**）。所以从 `return` 那一行取。
   */
  const start = code.indexOf('export function netPnlOf');
  const returnIdx = code.indexOf('return input.grossPnl', start);
  assert.ok(returnIdx > start, '找不到 `netPnlOf` 的 return —— 结构变了，请更新本测试');
  const impl = code.slice(returnIdx, code.indexOf(';', returnIdx) + 1);
  assert.match(
    impl,
    /return\s+input\.grossPnl\s*-\s*input\.fee\s*\+\s*input\.fundingFee;/,
    '★★★ `netPnlOf` 必须是 `毛 − 手续费 + 资金费` ——\n' +
      '    写成 `− 资金费` 会把"支出"加成"收入"（实测代价：每轮一条假账目告警，差额 = 资金费×2）。',
  );
});
