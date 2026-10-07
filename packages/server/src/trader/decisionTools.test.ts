import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractToolCalls,
  runDecisionTool,
  type DecisionToolDeps,
} from './decisionTools.js';
import type { ScreenCriteria, ScreenableSymbol } from '../market/screening.js';

/* -------------------------------------------------------------------------- */
/*  取数工具的解析与执行                                                          */
/* -------------------------------------------------------------------------- */

/** 只实现这个文件用得到的那几个取数入口。 */
function deps(overrides: Partial<DecisionToolDeps> = {}): DecisionToolDeps {
  return {
    klines: async () => [],
    candidates: async () => [],
    screenSymbols: async () => [],
    requestDeepAnalysis: async () => ({ accepted: [], rejected: [] }),
    applyPatch: async () => ({ applied: true, rejected: null, clamps: [] }),
    ...overrides,
  } as DecisionToolDeps;
}



test('★ set_params：决策轮也必须能改自己的参数 —— 这一条为一个死锁而写', async () => {
  /*
   * ## 实测（2026-10-02，`#1836` 的思考原文）
   *
   *   「账户所有者要求把单笔风险预算改为 5%，**但本轮无 set_params 工具可用**，
   *     按现有 2% 预算执行」
   *
   * 这就是死锁：**决策轮看得到指示、却没有改规则的权限；复盘轮有权限、
   * 但它用另一套 system 提示词、看不到账户所有者的取向。**
   * 模型被夹在中间，只能一直用 2% 熬着。
   *
   * 而"改不动自己的参数"正好违背用户的判断：
   * 「系统要最大化为模型提供能力、配合模型的意图」。
   *
   * 安全边界不变 —— 真正生效与否由注入的 `applyPatch`（走 `applyAgentPatch`
   * 的结构性守卫）决定，这里只钉住"这条通道存在、参数被正确转交"。
   */
  const seen: Array<{ patch: Record<string, unknown>; reason: string }> = [];
  const out = await runDecisionTool(
    {
      tool: 'set_params',
      args: {
        patch: { promptSections: { entryStandards: '单笔风险 ≤ 权益 5%' } },
        reason: '低波动标的走不出止盈所需的幅度',
      },
    },
    deps({
      applyPatch: async (patch, reason) => {
        seen.push({ patch, reason });
        return { applied: true, rejected: null, clamps: [] };
      },
    }),
  );
  assert.equal(seen.length, 1, '必须真的把 patch 交给注入的实现');
  assert.deepEqual(seen[0]!.patch, { promptSections: { entryStandards: '单笔风险 ≤ 权益 5%' } });
  assert.match(seen[0]!.reason, /低波动/, 'reason 必须透传 —— 无理由的改动事后无法复查');
  assert.match(out.summary, /已生效/);
});

test('set_params 也接受平铺字段 —— 多认格式，不放宽语义', async () => {
  /*
   * 与 `screen_symbols` 同时认下划线与驼峰同一个道理：模型把字段写在顶层
   * （而不是包在 `patch` 里）时，**整条调用不该作废** —— 那会白烧一轮。
   */
  let captured: Record<string, unknown> = {};
  await runDecisionTool(
    { tool: 'set_params', args: { coinSource: { coinPoolLimit: 30 }, reason: '拓宽候选' } },
    deps({
      applyPatch: async (patch) => {
        captured = patch;
        return { applied: true, rejected: null, clamps: [] };
      },
    }),
  );
  assert.deepEqual(captured, { coinSource: { coinPoolLimit: 30 } }, 'reason 不能混进 patch');
});

test('set_params 缺 reason 时拒绝执行，并说清为什么', async () => {
  let called = false;
  const out = await runDecisionTool(
    { tool: 'set_params', args: { patch: { coinSource: { coinPoolLimit: 30 } } } },
    deps({
      applyPatch: async () => {
        called = true;
        return { applied: true, rejected: null, clamps: [] };
      },
    }),
  );
  assert.equal(called, false, '没有 reason 就不该真的改');
  assert.match(out.text, /reason/);
});

test('set_params 被结构性守卫拒绝时如实回报 —— 不能假装改成了', async () => {
  const out = await runDecisionTool(
    {
      tool: 'set_params',
      args: { patch: { riskControl: { altcoinMaxLeverage: 200 } }, reason: '想更激进' },
    },
    deps({
      applyPatch: async () => ({
        applied: false,
        rejected: 'altcoinMaxLeverage 上限 125',
        clamps: [],
      }),
    }),
  );
  assert.match(out.text, /没有生效/, '★ 被拒必须如实说 —— 假装成功会让它基于错误前提继续推理');
  assert.match(out.summary, /被拒/);
});

test('★ screen_symbols：条件由模型给，系统只负责筛', async () => {
  /*
   * 用户 2026-09-30 的原话：「**模型是大脑，系统只是他的手脚**」。
   *
   * 第 0 层「全景」让它看见全部标的，第 1 层「聚焦」给出各维度头部 ——
   * 但那两层都是**系统选好的视角**。这个工具让它说
   * 「我要看成交额 5000 万–2 亿、波动大于 5% 的那一批」，而系统照办。
   */
  const seen: ScreenCriteria[] = [];
  const rows: ScreenableSymbol[] = [
    { symbol: 'MIDUSDT', changePercent24h: 4.2, quoteVolume24h: 120_000_000, amplitudePercent: 6.5 },
  ];
  const out = await runDecisionTool(
    {
      tool: 'screen_symbols',
      args: { min_quote_volume_24h: 50_000_000, min_amplitude_percent: 5, limit: 12 },
    },
    deps({
      screenSymbols: async (criteria) => {
        seen.push(criteria);
        return rows;
      },
    }),
  );

  assert.deepEqual(
    seen[0],
    { minQuoteVolume24h: 50_000_000, minAmplitudePercent: 5, limit: 12 },
    '下划线参数要转成筛选器的字段',
  );
  assert.match(out.text, /MIDUSDT/, '结果里要有符号');
  assert.match(out.text, /4\.2/, '要带涨跌幅');
  assert.match(out.text, /6\.5/, '要带振幅');
  assert.match(out.summary, /1 个/, '落库摘要要能看出筛出几个');
});

test('★ 参数同时接受下划线与驼峰 —— 模型不一定会照我们的写法', () => {
  /*
   * 与 `extractToolCalls` 的注释同一个道理：**多认格式，不放宽语义**。
   * 模型写成 `minQuoteVolume24h` 时不该整条调用作废 —— 那会白烧一轮。
   */
  return (async () => {
    const seen: ScreenCriteria[] = [];
    await runDecisionTool(
      {
        tool: 'screen_symbols',
        args: { minQuoteVolume24h: 50_000_000, maxChangePercent: -3 },
      },
      deps({
        screenSymbols: async (criteria) => {
          seen.push(criteria);
          return [];
        },
      }),
    );
    assert.deepEqual(seen[0], { minQuoteVolume24h: 50_000_000, maxChangePercent: -3 });
  })();
});

test('★ 筛不出东西时给一句可读的话，而不是抛错', async () => {
  /*
   * "这个条件现在筛不出东西"是**模型分析过程中的一次挫折**，不是系统故障 ——
   * 它应该读到这句话，然后放宽条件再要一次，或者用手上的数据继续判断。
   * 抛错会让整个决策周期失败，代价完全不成比例。
   */
  const out = await runDecisionTool(
    { tool: 'screen_symbols', args: { min_quote_volume_24h: 9_999_999_999_999 } },
    deps({ screenSymbols: async () => [] }),
  );
  assert.match(out.text, /没有符合条件/, '要如实说筛不出');
  assert.match(out.text, /放宽|换个条件/, '要告诉它下一步能怎么做');
  assert.match(out.summary, /0 个/);
});

test('未知工具被拒，且回复里列出可用工具', async () => {
  const out = await runDecisionTool({ tool: 'do_magic', args: {} }, deps());
  assert.match(out.text, /没有名为 do_magic 的工具/);
  assert.match(out.text, /screen_symbols/, '要告诉它有哪些工具可用');
});

test('取数抛错时回一句可读的话，而不是让整轮失败', async () => {
  const out = await runDecisionTool(
    { tool: 'screen_symbols', args: {} },
    deps({
      screenSymbols: async () => {
        throw new Error('网络抖了一下');
      },
    }),
  );
  assert.match(out.text, /网络抖了一下/);
  assert.match(out.text, /再要一次|继续/, '要给它一条退路');
});

test('★ request_deep_analysis：模型点名之后，系统记下它下一轮要看的标的', async () => {
  /*
   * 用户 2026-09-30 的原话：「**模型是大脑，系统只是他的手脚**」。
   *
   * `screen_symbols` 让它**筛**，这个工具让它**记住**：筛出来之后说
   * "下一轮把这几个给我完整行情"。没有它，它上一轮的发现**当场作废** ——
   * 每轮都从零开始看系统选的那十几个候选。
   */
  const seen: Array<{ symbols: string[]; reason?: string }> = [];
  const out = await runDecisionTool(
    {
      tool: 'request_deep_analysis',
      args: { symbols: ['btcusdt', 'ETHUSDT'], reason: '成交额放大' },
    },
    deps({
      requestDeepAnalysis: async (payload) => {
        seen.push(payload);
        return { accepted: ['BTCUSDT', 'ETHUSDT'], rejected: [] };
      },
    }),
  );

  assert.deepEqual(
    seen[0],
    { symbols: ['BTCUSDT', 'ETHUSDT'], reason: '成交额放大' },
    '符号要规范化成大写后传下去',
  );
  assert.match(out.text, /BTCUSDT/, '要回显它点名的标的');
  assert.match(out.text, /下一轮/, '要明确说"下一轮" —— 它得知道什么时候能看到');
  assert.match(out.summary, /2 个/);
});

test('★ 超上限时如实说"只收下了前几个"，而不是假装全都记下了', async () => {
  /*
   * 假装全都记下会让它下一轮直接找不到 —— 那比"当场被拒"更糟：
   * 它会以为自己看过了。所以这里必须如实说哪些没收。
   */
  const out = await runDecisionTool(
    { tool: 'request_deep_analysis', args: { symbols: ['AUSDT', 'BUSDT', 'CUSDT'] } },
    deps({
      requestDeepAnalysis: async () => ({
        accepted: ['AUSDT', 'BUSDT'],
        rejected: ['CUSDT'],
      }),
    }),
  );
  assert.match(out.text, /AUSDT/);
  assert.match(out.text, /CUSDT/, '★ 被拒的也要说出来');
  assert.match(out.text, /没|未|超出|满/, '要说清为什么没收下');
  assert.match(out.summary, /2 个/);
});

test('点名空清单时给可读的话，而不是静默成功', async () => {
  const out = await runDecisionTool(
    { tool: 'request_deep_analysis', args: { symbols: [] } },
    deps({ requestDeepAnalysis: async () => ({ accepted: [], rejected: [] }) }),
  );
  assert.match(out.text, /symbols|标的/, '要告诉它这个工具该怎么用');
});

test('extractToolCalls 认得 <tool> 标签，认不出就不猜', () => {
  const calls = extractToolCalls(
    '我先看看市场。<tool>{"tool":"screen_symbols","args":{"limit":5}}</tool> 然后再说。',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, 'screen_symbols');
  assert.deepEqual(calls[0]!.args, { limit: 5 });

  assert.deepEqual(extractToolCalls('没有工具调用的普通回复'), []);
  assert.deepEqual(extractToolCalls('<tool>这不是 json</tool>'), [], '解析不出来就当没有');
});
/*
 * ⚠️ **无效周期必须当场拒掉、并把可用值回喂。**
 *
 * 2026-10-07 实测日志：
 *
 *   取数工具 get_klines 执行失败：币安错误 -1120：Invalid interval.
 *
 * 模型给了一个不存在的周期，请求打到币安才被拒，而回给它的只有一句
 * `Invalid interval` —— 既没说哪个值错、也没说该用什么。它只能瞎猜，
 * **白烧一轮**（而现在一轮要十几分钟）。
 *
 * 工具说明里列了可用周期，但那是"给它看的"，不是"对它强制的"。
 * 这条用例钉住"强制"那一层。
 */
test('★ get_klines：无效周期在本地就被拒，并回喂可用值', async () => {
  const calls: string[] = [];
  const d = deps({
    klines: async (_symbol, timeframe) => {
      calls.push(timeframe);
      return [];
    },
  });

  const bad = await runDecisionTool(
    { tool: 'get_klines', args: { symbol: 'BTCUSDT', timeframe: '90m', count: 10 } },
    d,
  );
  assert.match(bad.text, /90m/, '要点名是哪个值错了');
  assert.match(bad.text, /1m/, '要把可用周期回喂给它');
  assert.equal(calls.length, 0, '★ 无效周期不该打到币安 —— 那正是白烧一轮的来源');

  // 合法周期照旧放行
  await runDecisionTool({ tool: 'get_klines', args: { symbol: 'BTCUSDT', timeframe: '15m', count: 10 } }, d);
  assert.deepEqual(calls, ['15m']);
});