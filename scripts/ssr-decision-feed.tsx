/**
 * 决策流的 SSR 回归检查 —— 把 `CycleBlock` 渲染成 HTML，断言**四种执行状态都写出来了**。
 *
 * ## 它防的是哪一个 bug
 *
 * 操作者报告：决策流里明明白白写着 `开空 POWERUSDT`，而账户里既没有仓位、也没有
 * 订单、也没有成交。数据库里那一轮是这样的：
 *
 *     周期 #38（success=1）
 *       决策: open_short POWERUSDT / open_short AKEUSDT
 *       执行: [skipped] 单日亏损熔断：今日已实现亏损 $0.59，占权益 6.03%（上限 5%）
 *
 * 熔断**做对了**，界面把它藏了：`DecisionFeed` 只从 `executionLog` 里筛
 * `rejected` 与 `failed`，而 `autoTrader.ts` 还会发 `skipped`（熔断、安全模式、
 * 再入冷却、没有行情、没有价格、没有持仓可平）。四种状态漏掉一种，屏幕上就只剩下
 * 一行干干净净的提案 —— 看起来像正在下单（`LAYOUT.md` §7：文字说的必须是事实）。
 *
 * ## 为什么是 SSR 而不是 typecheck
 *
 * `typecheck` 与 `build` 对"某个状态被静默丢掉"完全无感：漏掉一个 `filter` 分支，
 * 类型全对、构建全绿，只有屏幕上少了一句话。SSR 断言的是**渲染结果里有没有那句话**，
 * 这正是要钉住的东西。
 *
 * ## 为什么它有一个 `.mjs` 入口（`ssr-decision-feed.mjs`）
 *
 * 这个 `.tsx` **不能当入口**：`tsx` 决定 JSX 转换方式靠的是"入口文件所在目录树里有没有
 * 一份带 `jsx: react-jsx` 的 `tsconfig.json`" —— `packages/web/src/**` 命中
 * `packages/web/tsconfig.json`，而 `scripts/` 不在任何 workspace 里，于是它被按
 * **经典**模式编译（`React.createElement`），一跑就在别人的组件里抛
 * `ReferenceError: React is not defined`。
 *
 * 让 tsx 读到正确配置的唯一办法是**在它启动之前**把 `TSX_TSCONFIG_PATH` 设成
 * `packages/web/tsconfig.json` 的**绝对路径**（相对路径会被子进程按自己的 cwd 解析）。
 * 本进程里赋值来不及 —— 模块解析在入口文件第一行之前就完成了，所以这件事交给
 * `ssr-decision-feed.mjs` 做。
 *
 * ## 用法
 *
 *     npm run test:feed                       # 推荐
 *     node scripts/ssr-decision-feed.mjs      # 等价，任何工作目录都行
 *
 * ## 它不是"通过就算完"的检查
 *
 * 每条断言都对应一个**具体的事故**（见下面各段的注释）。断言失败时会打印出周期 #38
 * 的实际 HTML —— 那就是操作者本来会看到的东西，先看它，再改代码。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Decision, DecisionRecord, ExecutionLogEntry } from '@aq/shared';
import { CycleBlock } from '../packages/web/src/components/DecisionFeed';
import type { MarketSymbol } from '../packages/web/src/lib/api';

/* -------------------------------------------------------------------------- */
/*  夹具                                                                       */
/* -------------------------------------------------------------------------- */

function decision(over: Partial<Decision> & Pick<Decision, 'symbol' | 'action'>): Decision {
  return {
    leverage: 5,
    positionSizeUsd: 30,
    stopLoss: null,
    takeProfit: null,
    confidence: 70,
    riskUsd: 3,
    reasoning: '夹具里的理由文字。',
    adjustments: [],
    ...over,
  };
}

function entry(
  over: Partial<ExecutionLogEntry> &
    Pick<ExecutionLogEntry, 'action' | 'symbol' | 'status' | 'detail'>,
): ExecutionLogEntry {
  return { ...over };
}

function record(
  over: Partial<DecisionRecord> &
    Pick<DecisionRecord, 'cycleNumber' | 'decisions' | 'executionLog'>,
): DecisionRecord {
  return {
    id: over.cycleNumber,
    traderId: 5,
    timestamp: new Date('2026-02-01T04:00:00.000Z').toISOString(),
    systemPrompt: '系统提示词',
    userPrompt: '用户提示词',
    cotTrace: '思维链',
    rawResponse: '{}',
    candidateSymbols: [],
    success: true,
    error: null,
    aiLatencyMs: 12_300,
    promptTokens: 34_411,
    completionTokens: 4_980,
    ...over,
  };
}

const marketSymbol = (symbol: string, price: number): MarketSymbol => ({
  symbol,
  baseAsset: symbol.replace(/USDT$/, ''),
  price,
  changePercent24h: 0,
  quoteVolume24h: 0,
  minNotional: 5,
});

/** 操作者报告的那一轮：两条决策都被熔断跳过，而 `success` 是 true。 */
const CYCLE_38 = record({
  cycleNumber: 38,
  decisions: [
    decision({ symbol: 'POWERUSDT', action: 'open_short', confidence: 70 }),
    decision({ symbol: 'AKEUSDT', action: 'open_short', confidence: 68 }),
  ],
  executionLog: [
    entry({
      action: 'open_short',
      symbol: 'POWERUSDT',
      status: 'skipped',
      detail: '单日亏损熔断：今日已实现亏损 $0.59，占权益 6.03%（上限 5%）。',
    }),
    entry({
      action: 'open_short',
      symbol: 'AKEUSDT',
      status: 'skipped',
      detail: '单日亏损熔断：今日已实现亏损 $0.59，占权益 6.03%（上限 5%）。',
    }),
  ],
});

/** 四种状态各一条：`ok` / `rejected` / `failed` / `skipped` 必须长得不一样。 */
const ALL_FOUR = record({
  cycleNumber: 39,
  decisions: [
    decision({
      symbol: 'BTCUSDT',
      action: 'open_long',
      adjustments: ['杠杆已从 20x 压到上限 5x。'],
    }),
    decision({ symbol: 'ETHUSDT', action: 'open_long' }),
    decision({ symbol: 'SOLUSDT', action: 'open_short' }),
    decision({ symbol: 'DOGEUSDT', action: 'open_short' }),
  ],
  executionLog: [
    entry({
      action: 'open_long',
      symbol: 'BTCUSDT',
      status: 'ok',
      detail: '已开仓多头 0.0004 @ 68000。 运行时调整：杠杆已从 20x 压到上限 5x。',
      orderId: 'A1',
      notionalUsd: 27.2,
      adjustments: ['杠杆已从 20x 压到上限 5x。'],
    }),
    entry({
      action: 'open_long',
      symbol: 'ETHUSDT',
      status: 'rejected',
      detail: '单笔风险 $12.00 超过上限 $6.00。',
    }),
    entry({
      action: 'open_short',
      symbol: 'SOLUSDT',
      status: 'failed',
      detail: '下单被交易所拒绝：Margin is insufficient.',
    }),
    entry({
      action: 'open_short',
      symbol: 'DOGEUSDT',
      status: 'skipped',
      detail: '该标的处于再入冷却期（平仓后 30 分钟内不可再入场）。',
    }),
  ],
});

/** 同一个符号两条决策：日志必须按提出顺序**一对一**配上，不重复也不丢。 */
const SAME_SYMBOL = record({
  cycleNumber: 40,
  decisions: [
    decision({ symbol: 'BTCUSDT', action: 'close_long', positionSizeUsd: 0 }),
    decision({ symbol: 'BTCUSDT', action: 'open_short', confidence: 61 }),
  ],
  executionLog: [
    entry({
      action: 'close_long',
      symbol: 'BTCUSDT',
      status: 'skipped',
      detail: '本地没有该持仓的记录，无法平仓。',
    }),
    entry({
      action: 'open_short',
      symbol: 'BTCUSDT',
      status: 'ok',
      detail: '已开仓空头 0.0004 @ 68000。',
      orderId: 'B2',
      notionalUsd: 27.2,
    }),
  ],
});

/** 决策一条执行记录都没有，外加一条配不上任何决策的孤立日志。 */
const NO_MATCH = record({
  cycleNumber: 41,
  decisions: [decision({ symbol: 'XRPUSDT', action: 'wait', positionSizeUsd: 0 })],
  executionLog: [
    entry({
      action: 'close_short',
      symbol: 'ADAUSDT',
      status: 'skipped',
      detail: '本地没有该持仓的记录，无法平仓。',
    }),
  ],
});

/* -------------------------------------------------------------------------- */
/*  渲染 + 断言                                                                */
/* -------------------------------------------------------------------------- */

function html(rec: DecisionRecord, symbols: MarketSymbol[] = []): string {
  return renderToStaticMarkup(createElement(CycleBlock, { record: rec, symbols }));
}

/** 断言失败时把失败项攒起来（一次跑完所有断言，而不是第一个失败就退出）。 */
let failures = 0;

function check(name: string, rendered: string, expectations: Array<[string, boolean]>): void {
  for (const [what, ok] of expectations) {
    if (ok) {
      process.stdout.write(`  ✓ ${name} — ${what}\n`);
    } else {
      failures += 1;
      process.stdout.write(`  ✗ ${name} — ${what}\n`);
    }
  }
}

/** 断言"这个字符串在 HTML 里"，返回布尔 —— 让 `check` 能一次报出全部失败项。 */
const has = (haystack: string, needle: string): boolean => haystack.includes(needle);

/** 某个片段出现了几次。用于"一对一配对"这类断言。 */
const times = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/* --- 1. 操作者报告的那一轮：熔断原因必须出现在 HTML 里 --------------------- */

process.stdout.write('\n周期 #38（两条决策都被熔断跳过，success=true）\n');
const cycle38 = html(CYCLE_38);
check('周期 #38', cycle38, [
  ['出现「未执行」标记', has(cycle38, '未执行')],
  [
    '出现熔断原因全文（含具体数字）',
    has(cycle38, '单日亏损熔断：今日已实现亏损 $0.59，占权益 6.03%（上限 5%）。'),
  ],
  ['两条决策各自带一份原因', times(cycle38, '单日亏损熔断') === 2],
  ['底部小字报出「2 条未执行」', has(cycle38, '2 条未执行')],
  ['不再出现「没有给出任何决策」', !has(cycle38, '本周期模型没有给出任何决策')],
  // 这一条是本次修复的反面：只要原因没渲染出来，上面那条断言必挂。
  ['决策行上的动作徽章仍然在（提案本身没被删掉）', has(cycle38, '开空')],
]);

/* --- 2. 四种状态必须彼此可辨 --------------------------------------------- */

process.stdout.write('\n周期 #39（ok / rejected / failed / skipped 各一条）\n');
const four = html(ALL_FOUR, [marketSymbol('BTCUSDT', 68_000)]);
check('周期 #39', four, [
  ['✓ 已执行（ok）', has(four, '✓ 已执行')],
  ['⚠ 被风控拒绝（rejected）', has(four, '⚠ 被风控拒绝')],
  ['✕ 执行失败（failed）', has(four, '✕ 执行失败')],
  ['⊘ 未执行（已跳过）（skipped）', has(four, '⊘ 未执行（已跳过）')],
  ['风控拒绝的原因可见', has(four, '单笔风险 $12.00 超过上限 $6.00。')],
  ['失败的错误可见', has(four, 'Margin is insufficient.')],
  ['跳过的原因可见', has(four, '再入冷却期')],
  ['风控干预（adjustments）仍然显示', has(four, '杠杆已从 20x 压到上限 5x。')],
  ['成交金额仍然显示', has(four, '$27.20')],
  [
    'skipped 与 failed 用的不是同一段文字',
    has(four, '⊘ 未执行（已跳过）') && has(four, '✕ 执行失败') && !has(four, '✕ 未执行'),
  ],
  // 风控拒绝仍然报数（§7：被拒条目必须仍然可见）。
  ['底部小字报出「1 条被风控拒绝」', has(four, '1 条被风控拒绝')],
]);

/* --- 3. 同符号多条决策：一对一，不重复也不丢 ----------------------------- */

process.stdout.write('\n周期 #40（BTCUSDT 有平多与开空两条决策）\n');
const same = html(SAME_SYMBOL);
check('周期 #40', same, [
  ['平多拿到「本地没有该持仓的记录」', has(same, '本地没有该持仓的记录，无法平仓。')],
  ['开空拿到「已开仓空头」', has(same, '已开仓空头 0.0004 @ 68000。')],
  ['平多的原因只出现一次（没有被复制给开空）', times(same, '本地没有该持仓的记录') === 1],
  ['两条决策各拿到一条结果（徽章各一个）', times(same, 'chip border-base-700') === 1 && times(same, 'chip border-up/40') === 1],
]);

/* --- 4. 两侧"没有记录"都要说话 ------------------------------------------- */

process.stdout.write('\n周期 #41（决策无执行记录 / 日志配不上决策）\n');
const none = html(NO_MATCH);
check('周期 #41', none, [
  ['决策行说明运行时没有留下记录', has(none, '运行时没有留下这条决策的执行记录')],
  ['配不上决策的孤立日志仍然被列出', has(none, '本地没有该持仓的记录，无法平仓。')],
]);

/* --- 5. 一轮没有任何决策、也没有执行 ------------------------------------- */

process.stdout.write('\n周期 #42（空轮）\n');
const empty = html(record({ cycleNumber: 42, decisions: [], executionLog: [] }));
check('周期 #42', empty, [['说明模型没有给出决策', has(empty, '本周期模型没有给出任何决策')]]);

/* --- 6. 空轮但执行日志非空：不能说成"模型没有给出决策" ------------------- */

process.stdout.write('\n周期 #43（模型没给决策，但回撤守卫平了仓）\n');
const guardOnly = html(
  record({
    cycleNumber: 43,
    decisions: [],
    executionLog: [
      entry({
        action: 'close_long',
        symbol: 'ZECUSDT',
        status: 'skipped',
        detail: '本地没有该持仓的记录，无法平仓。',
      }),
    ],
  }),
);
check('周期 #43', guardOnly, [
  ['不再说成"模型没有给出任何决策"', !has(guardOnly, '本周期模型没有给出任何决策')],
  ['执行条目仍然可见', has(guardOnly, '本地没有该持仓的记录，无法平仓。')],
]);

if (failures > 0) {
  process.stdout.write(`\n--- 周期 #38 的实际 HTML ---\n${cycle38}\n`);
  process.exitCode = 1;
}
