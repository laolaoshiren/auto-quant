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
    ...overrides,
  } as DecisionToolDeps;
}

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
