/**
 * **摘要候选也必须带得出"最近 6 根收盘价"**（2026-10-15 线上实测）。
 *
 * ## 事故：策略师算不出自己的入场判据 `D`，而它判定这是"数据管道问题"
 *
 * 策略师（它自己有权定规则）在 `entryStandards` 里写下 `D` = **15m 连续 6 根收盘价的位移**
 *（门槛 0.8%、上限 3.5%），但它每一轮都写「D无法计算」：
 * ```
 *   「缺close[-6]/close[-1]序列无法算D」「缺15m连续收盘无法算D」
 *   「材料未给close[-6]」「序列缺失，D不可算」
 * ```
 * 而它在 `agent_runs#889` 自己下了结论：
 * ```
 *   「Many symbols (SUI, ENA, XRP, BNB, DOGE, HYPE, NEAR, PUMP, 1000PEPE)
 *     show 'D无法计算' across multiple cycles. This is a data pipeline issue
 *     (kline data not provided for all candidates), not fixable by parameter change.」
 * ```
 * **它对了一半**：确实是数据管道问题。但它给的病因（"kline 没采到"）不对。
 *
 * ## 真实病因（用真实渲染链量出来的）
 *
 * `buildUserPromptParts()` 只给**前 `detailedCandidateCount()` 个**候选完整序列
 *（默认预算下实测 = 5 个；硬上限 `DETAILED_HARD_CAP = 10`），其余走
 * `renderTimeframeSummary()`。那一段原来**一个原始收盘价都没有**：
 * ```
 *   5M: 价 44.0000(↑0.3%) | EMA20 43.9575 | … | ATR14 0.813580
 *   15M: 价 43.9658(↓0.2%) | EMA20 43.9834(↓0.1%) | …
 * ```
 * 于是「能不能算 D」**完全取决于这个标的排在候选第几位** —— 而候选是**按强弱排序**的，
 * 每轮可能换人，所以它跨轮反复点名同一批标的。
 *
 * ## 为什么原来的注释说"走向百分比更快、更省"在这里是错的
 *
 * 那句话对**指标**成立（EMA/RSI 是"读的结论"），对**收盘价不成立** ——
 * 收盘价是**算术的输入**。而那个 `(↑0.3%)` 是 `trendOf()` 用最后 5 个值算的，
 * 模型既不知道它是"几根之间"的位移，也无法核对，更算不出 `close[-6]` 与 `close[-1]`。
 *
 * ## 这组测试钉住三件事
 *
 * 1. 摘要候选**每个周期**都有 ≥6 个**原始收盘价**（不是百分比、不是省略号）。
 * 2. 详细候选经过 `compactSeriesLines(keepLast=10)` 之后仍然 ≥6（这是 `keepLast` 的下限依据）。
 * 3. 材料规模不能因此失控 —— 摘要候选块**保持在 1,200 字符以内**
 *    （危险线：12 标的 54,971 字符时 `mt=2048` 会让角色输出 0 字）。
 *
 * ⚠️ 数据用 `buildSyntheticMarket()`（与 `npm run sim` 同一份确定性夹具）+
 * **真实** `computeTimeframeIndicators` + **真实** `buildUserPrompt` +
 * **真实** `compactSeriesLines` —— 不自己造材料形状（那会让测试通过而线上不中）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultStrategyConfig,
  type IndicatorConfig,
  type Kline,
  type MarketSnapshot,
  type Timeframe,
  type TimeframeIndicators,
} from '@aq/shared';

import { computeTimeframeIndicators } from '../../market/indicators.js';
import { buildSyntheticMarket } from '../../simulate/syntheticCandles.js';
import { buildUserPrompt, emptyPromptMemory, type PromptContext } from '../../strategy/prompt.js';
import { compactSeriesLines, splitMarketContext } from './symbolSlices.js';

/* -------------------------------------------------------------------------- */
/*  Fixture                                                                    */
/* -------------------------------------------------------------------------- */

const TFS: Timeframe[] = ['5m', '15m', '1h', '4h'];

/**
 * 12 个候选 —— 与线上那一轮同量级（`#11` 实测 12 个候选）。
 *
 * 前 5 个名字就是策略师点名的那 5 个（SUI/ENA/XRP/BNB/DOGE），后 7 个是
 * 它点名却**从来拿不到序列**的那一批 —— 这样"谁在第几位"就与线上同形。
 */
const SYMBOLS = [
  'SUIUSDT',
  'ENAUSDT',
  'XRPUSDT',
  'BNBUSDT',
  'DOGEUSDT',
  'HYPEUSDT',
  'NEARUSDT',
  'PUMPUSDT',
  '1000PEPEUSDT',
  'SOLUSDT',
  'ETHUSDT',
  'BTCUSDT',
] as const;

const BASE_PRICES: Record<string, number> = {
  SUIUSDT: 3.1,
  ENAUSDT: 0.62,
  XRPUSDT: 2.4,
  BNBUSDT: 980,
  DOGEUSDT: 0.19,
  HYPEUSDT: 44,
  NEARUSDT: 5.4,
  PUMPUSDT: 0.0081,
  '1000PEPEUSDT': 0.0112,
  SOLUSDT: 190,
  ETHUSDT: 2500,
  BTCUSDT: 68000,
};

function snapshotOf(
  symbol: string,
  klines: Map<Timeframe, Kline[]>,
  config: IndicatorConfig,
): MarketSnapshot {
  const computed = config.kline.selectedTimeframes.map((tf) =>
    computeTimeframeIndicators(tf, klines.get(tf) ?? [], config),
  );
  const primary = computed[0]!;
  return {
    symbol,
    sources: ['coinpool'],
    price: primary.closes[primary.closes.length - 1] ?? 0,
    quoteVolume24h: 3.2e8,
    priceChangePercent24h: 4.1,
    high24h: 0,
    low24h: 0,
    primary,
    isMajor: symbol === 'BTCUSDT' || symbol === 'ETHUSDT',
    timeframes: computed,
    derivatives: {
      openInterest: null,
      openInterestUsd: null,
      openInterestAvg: null,
      openInterestChangePercent: {},
      fundingRate: null,
      nextFundingTime: null,
      markPrice: 0,
      indexPrice: 0,
    },
    quant: null,
  };
}

/** 与线上同形的材料：12 个候选 × 4 周期 × 60 根原始 K 线。 */
function buildOnlineLikeMaterial(promptPoints?: number): {
  material: string;
  candidates: MarketSnapshot[];
} {
  const base = defaultStrategyConfig();
  const config =
    promptPoints === undefined
      ? base
      : {
          ...base,
          indicators: {
            ...base.indicators,
            kline: { ...base.indicators.kline, promptPoints },
          },
        };
  const market = buildSyntheticMarket({
    symbols: SYMBOLS,
    timeframes: TFS,
    primary: '5m',
    candlesPerTimeframe: 60,
    startTime: 1_760_000_000_000,
    basePrices: BASE_PRICES,
  });
  const candidates = SYMBOLS.map((symbol) => {
    const source = market.get(symbol);
    assert.ok(source, `夹具缺 ${symbol}`);
    return snapshotOf(symbol, source.klines, config.indicators);
  });
  const ctx: PromptContext = {
    traderName: 'summary-closes-test',
    cycleNumber: 1,
    now: new Date(1_760_000_000_000),
    config,
    account: {
      equity: 100,
      availableBalance: 80,
      unrealizedPnl: 0,
      marginUsed: 20,
      positionCount: 0,
    },
    positions: [],
    candidates,
    oiRanking: [],
    memory: emptyPromptMemory(config),
    universeTrimmedFrom: null,
    pendingEntries: [],
  };
  return { material: buildUserPrompt(ctx), candidates };
}

/* -------------------------------------------------------------------------- */
/*  量材料                                                                      */
/* -------------------------------------------------------------------------- */

interface Candidate {
  symbol: string;
  /** 每个周期一段文本。 */
  periods: Map<string, string>;
  chars: number;
}

/**
 * 把渲染好的候选段切成"每周期一段"。
 *
 * 详细候选的周期标题是 `=== 15M 周期（由旧到新）===`；摘要候选是 `15M: 价 … | …`。
 * 两种都必须认得 —— 否则这个测试会漏掉它要防的那一半。
 */
function splitCandidates(material: string): Candidate[] {
  const body = material.slice(
    material.indexOf('<UNTRUSTED_MARKET_DATA>') + '<UNTRUSTED_MARKET_DATA>'.length,
    material.indexOf('</UNTRUSTED_MARKET_DATA>'),
  );
  const blocks = body.split(/^(?=### \d+\. )/m).filter((b) => /^### \d+\. /.test(b));
  return blocks.map((block) => {
    const symbol = /^### \d+\. (\S+?)(?:（|\s*$)/m.exec(block)?.[1] ?? '?';
    const periods = new Map<string, string>();
    const detailedRe = /^=== ([0-9A-Z]+) 周期（由旧到新）===\n([\s\S]*?)(?=\n=== |\n*$)/gm;
    let m: RegExpExecArray | null;
    while ((m = detailedRe.exec(block)) !== null) periods.set(m[1]!, m[2]!);
    if (periods.size === 0) {
      for (const line of block.split('\n')) {
        const s = /^([0-9A-Z]+): (.*)$/.exec(line.trim());
        if (s !== null) periods.set(s[1]!, s[2]!);
      }
    }
    return { symbol, periods, chars: block.length };
  });
}

/** 一段周期文本里第一串"足够长"的收盘价数组的点数（详细区块的 `价格:` 或摘要的 `最近N根收盘`）。 */
function closesIn(periodText: string): number {
  const matches = [
    ...periodText.matchAll(/(?:价格|最近\d+根收盘):? \[([^\]]{40,})\]/g),
  ];
  const first = matches[0];
  if (first === undefined) return 0;
  return (first[1] ?? '')
    .replace(/^…省略前 \d+ 个…,?\s*/, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^-?\d/.test(s)).length;
}

/* -------------------------------------------------------------------------- */
/*  测试                                                                        */
/* -------------------------------------------------------------------------- */

test('★★★ 每一个候选、每一个周期都带着 ≥6 个原始收盘价（否则策略师算不出自己的 D）', () => {
  const { material } = buildOnlineLikeMaterial();
  const candidates = splitCandidates(material);
  assert.equal(candidates.length, SYMBOLS.length, '12 个候选都该渲染出来');

  const short: string[] = [];
  for (const c of candidates) {
    for (const tf of TFS) {
      const text = c.periods.get(tf.toUpperCase());
      assert.ok(text !== undefined, `候选 ${c.symbol} 缺 ${tf} 段`);
      const n = closesIn(text);
      if (n < 6) short.push(`${c.symbol}/${tf}=${n}`);
    }
  }
  assert.deepEqual(
    short,
    [],
    `★ 这些候选/周期拿不出 15m 6 根收盘位移（D）所需的原始收盘价：${short.join(', ')}\n` +
      '—— 修复前摘要候选（第 6 个之后）在这里是 0；回到那个状态策略师会继续写「D无法计算」',
  );
});

test('★★★ 摘要候选给的是【原始数字】，不是一个看不懂的走向百分比', () => {
  /*
   * ⚠️ 这条是防"用 `(↑0.3%)` 冒充收盘价"的回归：
   * `trendOf()` 取的是最后 5 个值，而入场判据要的是 6 根之间的位移 ——
   * 让模型拿一个它无法核对、也无法复算的百分比去凑判据，
   * 与"没有数据"只差一层错觉。
   */
  const { material } = buildOnlineLikeMaterial();
  const candidates = splitCandidates(material);
  /* 第 6 个之后是摘要候选（详细个数 ≥5，硬上限 10 —— 取一个必然在摘要里的位置）。 */
  const summary = candidates[11]!;
  const m15 = summary.periods.get('15M');
  assert.ok(m15 !== undefined, '摘要候选必须有 15M 段');
  assert.match(m15, /最近6根收盘 \[[-\d.,\s]+\]/, `★ 15M 段必须列出 6 个原始收盘价（实际：${m15}）`);
  const n = closesIn(m15);
  assert.equal(n, 6, `★ 摘要给 6 个点（实际 ${n}）——少了算不出 D，多了摘要就不再便宜`);

  /*
   * ⚠️ **那 6 个数必须就是真实序列的末尾 6 个**（防"格式对、值不对"）：
   * 抄错一位就是一条错误的入场判据，而模型不会知道该怀疑哪一边。
   * 对照物是 `computeTimeframeIndicators` 算出的 `closes` —— 与渲染同源。
   *
   * ⚠️ 比的是**渲染后的精度**：`priceDecimalsFor()` 按量级取位
   *（<1 → 6 位、<1000 → 4 位、≥1000 → 2 位），BTCUSDT 那类高价币渲染的是 `68176.67`。
   * 所以判据是"**与详细区块同一个精度渲染后逐字相等**"，
   * 而不是"等于浮点原值" —— 后者会红在一个与本次修复无关的显示约定上。
   */
  const snap = buildOnlineLikeMaterial().candidates[11]!;
  const raw15 = snap.timeframes.find((t) => t.timeframe === '15m')!.closes.slice(-6);
  const decimals = raw15[0]! >= 1000 ? 2 : raw15[0]! >= 1 ? 4 : 6;
  const expected = `最近6根收盘 [${raw15.map((v) => v.toFixed(decimals)).join(', ')}]`;
  assert.ok(
    m15.includes(expected),
    `★ 摘要里的 6 个收盘价必须等于真实序列末尾 6 个\n  期望片段：${expected}\n  实际：${m15}`,
  );
});

test('★★★ 团队处理链跑完之后，摘要里的 6 根收盘价必须原样还在（Lead 要求的接缝验证）', () => {
  /*
   * ## 为什么必须单独验这一条
   *
   * 团队模式对**已经渲染好的字符串**做三级串联处理，而不是重新渲染：
   * ```
   *   ① splitMarketContext(marketContext)      —— 按 `### N. SYMBOL` 切片
   *   ② 取前 N 个切片发给分析师 / 裁决官
   *   ③ compactSeriesLines(text, 10)           —— 压 K 线序列
   * ```
   * 而 ③ 的正则是**行尾锚定**的：
   * ```
   *   /^([ \t]*)([^:[\n]{1,20}): \[([^\]]*)\][ \t]*$/gm
   * ```
   * 我的摘要行形状是 `15M: 价 44.0 | 最近6根收盘 [44.1143, …]` ——
   * 它**不以 `]` 结尾**（后面还有 ` | EMA20 …`），所以理论上不会被匹配。
   * 但"我读了觉得对"不是验证：这一条真的把链路跑一遍。
   *
   * ⚠️ 若哪天有人把摘要行改成"每个数字一行"或"以 `]` 收尾"，
   * 压缩会命中它 —— 那时这一条会红，而这正是我们要的告警
   *（否则症状是"团队角色又算不出 D"，与本次事故同类、极难定位）。
   */
  const { material, candidates } = buildOnlineLikeMaterial();
  const split = splitMarketContext(material);
  assert.ok(split !== null, '材料必须能按候选切开（切不开团队会退回原文，这条就失去意义）');
  assert.equal(split.slices.length, SYMBOLS.length, '12 个候选都该成为切片');

  const slice = split.slices[11]!;
  const compacted = compactSeriesLines(slice.text, 10);
  assert.equal(compacted, slice.text, '★ 摘要切片不含可压的 `标签: [数字]` 行 —— 压缩必须一字不改');

  const m15 = /^15M: (.*)$/m.exec(compacted)?.[1] ?? '';
  assert.match(m15, /最近6根收盘 \[[-\d.,\s]+\]/, '压缩后 15M 摘要行必须原样还在');
  const n = closesIn(`15M: ${m15}`);
  assert.equal(n, 6, `压缩后仍要 6 个收盘价（实际 ${n}）`);

  /* `close[-6]` 与 `close[-1]` 都要读得到 —— 那是策略师 D 判据的全部输入。 */
  const nums = (/最近6根收盘 \[([^\]]*)\]/.exec(m15)?.[1] ?? '').split(',').map((s) => Number(s.trim()));
  assert.equal(nums.length, 6, '要能解析出 6 个数');
  const snap = candidates[11]!;
  const rawTail = snap.timeframes.find((t) => t.timeframe === '15m')!.closes.slice(-6);
  /*
   * 比的是渲染精度下的值（BTCUSDT 渲染成 `68176.67`）—— 见上一条测试的说明。
   * 判据：相对误差 < 1e-6（远小于那 0.8% 的门槛，不影响 D 的判定）。
   */
  const same = (rendered: number, raw: number): boolean =>
    Math.abs(rendered - raw) / Math.max(1, Math.abs(raw)) < 1e-6;
  assert.ok(same(nums[0]!, rawTail[0]!), `★ close[-6] 必须可读且等于真实值（读到 ${nums[0]}，真实 ${rawTail[0]}）`);
  assert.ok(same(nums[5]!, rawTail[5]!), `★ close[-1] 必须可读且等于真实值（读到 ${nums[5]}，真实 ${rawTail[5]}）`);
  /* 位移就是这个判据的核心算式 —— 顺手确认它真的能算出来。 */
  const displacement = ((nums[5]! - nums[0]!) / nums[0]!) * 100;
  assert.ok(Number.isFinite(displacement), '15m 6 根位移必须算得出一个有限数');
});

test('★★★ 详细候选被 compactSeriesLines 压缩后仍然留着 ≥6 点（keepLast 的下限依据）', () => {
  /*
   * 详细候选走的是 `compactMarketContext(input.marketContext, 10)`（线上路径）。
   * 而"10"这个数之所以够用，全部理由是**压缩后还剩 ≥6 点** ——
   * 若哪天有人把 keepLast 调到 5，`D` 会在**详细候选**上也重新变成不可算，
   * 而症状与本次事故一模一样（"缺close[-6]"），很难再定位。
   */
  const { material } = buildOnlineLikeMaterial();
  const first = splitCandidates(material)[0]!;
  const compacted = compactSeriesLines(first.periods.get('15M') ?? '', 10);
  assert.equal(closesIn(compacted), 10, '15M 压缩后该留 10 点');
  assert.ok(closesIn(compacted) >= 6, '压缩后必须仍然够算 6 根位移');
  /* 压缩必须真的发生（否则这条断言在"没有压缩"的世界里也绿）。 */
  assert.match(compacted, /省略前 \d+ 个/);
});

test('★ 摘要候选的规模必须留在预算内（危险线：12 标的 54,971 字符 → content=0 字）', () => {
  /*
   * ⚠️ 这一条防的是"修法本身把角色噎住"：
   * 实测把摘要放开到配置的 30 点会让每个摘要候选 792 → 2,037 字符、整体 56,961 → 65,216。
   * 材料规模直接决定角色会不会写不出内容，所以给摘要候选钉一个上限。
   *
   * 1,200 来自实测：6 个收盘价 × 4 周期 ≈ +256 字符，而修复后实测块 1,048–1,114 字符。
   */
  const { material } = buildOnlineLikeMaterial();
  const candidates = splitCandidates(material);
  const summary = candidates.slice(5);
  assert.ok(summary.length > 0, '这个夹具下第 6 个之后应该都是摘要候选');
  for (const c of summary) {
    assert.ok(
      c.chars <= 1_200,
      `★ 摘要候选 ${c.symbol} 涨到 ${c.chars} 字符（上限 1,200）—— 摘要变厚会取消分层，` +
        '而分层是为了避开"材料太大 → 角色 0 字"那条线',
    );
  }
});

test('★ 把 `promptPoints` 调到 5 也不能让 D 重新变成不可算（摘要不吃这个参数）', () => {
  /*
   * ## 这是一个已知的"参数能让判据失效"的口子
   *
   * `promptPoints` 的下限是 5（schema），而 `D` 要 6 根收盘价 ——
   * 也就是说 AI 只要"为了省 token"把它调到 5，**详细候选**的 `价格:` 就只剩 5 点，
   * 于是 `close[-6]` 又没了。而它不会认为那是自己调错了，只会像这一轮一样写
   * 「缺close[-6]序列无法算D」。
   *
   * ⚠️ 这**不是一个已经完全修好的洞**：详细候选的渲染跟着 `promptPoints` 走
   *（那是它调厚薄的权利），所以 `promptPoints = 5` 时详细候选只有 5 点。
   * 这里钉住的是**修复之后至少还有一条路能算出 D**：摘要候选不受这个参数影响。
   *
   * 若哪天要彻底关掉这个口子，正确的做法是给 `renderTimeframe` 的价格序列也加一条
   * "≥6 根"的下限 —— 但那会改掉"AI 可以自己权衡历史厚度"这个已声明的权限，
   * 属于产品决策，不该顺手做。
   */
  const { material } = buildOnlineLikeMaterial(5);
  const candidates = splitCandidates(material);
  const summary = candidates[11]!;
  const m15 = summary.periods.get('15M');
  assert.ok(m15 !== undefined, '摘要候选必须有 15M 段');
  assert.equal(closesIn(m15), 6, '摘要的 6 根收盘价不该被 promptPoints 带着走');
});

test('★ 概述标题与摘要行【都不能说谎】：概述不动（有正则钉着），摘要行自称带了什么', () => {
  /*
   * ## 为什么不能顺手把那句概述改成"最近 6 根收盘价"
   *
   * 团队模式对这段已渲染文本做**定点替换**（`tradingDesk.ts` 的
   * `rewriteCandidateHeader`），而它的正则被 `analystMaterial.test.ts`
   * 用**线上原文**逐字钉着：
   * ```
   *   **其余只给摘要**（最新值 + 最近 5 根的走向）—— 那足够用来筛掉它们，
   * ```
   * 改一个字，那个替换就**静默不中** —— 后果是分析师材料的标题又变回
   * 「候选 12 个、前 5 个完整序列」而正文只有 6 个，也就是
   * `analystMaterial.test.ts` 记过的"材料自相矛盾、四个角色每轮各写 200–400 字解释它"。
   *
   * 所以口径是：**概述一个字不动，摘要行自己说自己带了什么。**
   * 模型实际读的是摘要行（`最近6根收盘 [...]`），而它说得完全准确。
   */
  const { material } = buildOnlineLikeMaterial();
  assert.match(
    material,
    /其余只给摘要\*\*（最新值 \+ 最近 5 根的走向）—— 那足够用来筛掉它们，/,
    '★ 这句概述不能改 —— 它是 tradingDesk 定点替换的锚（改了会静默不中）',
  );
  assert.match(material, /最近6根收盘 \[/, '★ 摘要行必须自称带了 6 根收盘价');
});
