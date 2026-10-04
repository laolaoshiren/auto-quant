/**
 * 工具层的参数校验与分发。
 *
 * ## 为什么这些用例存在
 *
 * 模型的工具调用是**不可信输入**。这里的每一条都对应一种"它会怎么错"：
 * 幻觉出一个工具名、少给必填参数、把数字写成字符串、给一个越界的 limit、
 * 或者用 `set_params` 试图绕开结构性守卫。
 *
 * 校验一旦失效，**后果不是"结果不好看"，而是拿模型的输出当代码用**：
 * 一个负的 limit、一个字符串当数量、一个幻觉出来的工具名，
 * 都可能让循环崩掉或者做出它没打算做的事。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStrategyConfig, STRATEGY_PRESETS, StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { AGENT_TOOLS, derivedRiskFigures, dispatchTool, renderToolCatalogue, validateArgs, type AgentToolDeps } from './tools.js';

const config = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  }) as StrategyConfig;

/** 一个把读工具全部记账的桩：要断言"到底调没调、用的是什么参数"。 */
function makeDeps(overrides: Partial<AgentToolDeps> = {}) {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const saved: Array<{ reason: string; patch: unknown; clamps: unknown }> = [];
  const rejected: Array<{ reason: string; patch: unknown; rejected: unknown }> = [];
  const pauses: string[] = [];
  /** `resume_trading` 的调用记录（与 `pauses` 成对）。 */
  const cycleIntervals: number[] = [];
  let current = config();

  const deps: AgentToolDeps = {
    currentConfig: () => current,
    saveConfig: (next, context) => {
      current = next;
      saved.push(context);
    },
    recordRejectedPatch: (meta) => rejected.push(meta),
    read: {
      performance: (window) => {
        calls.push({ tool: 'get_performance', args: { window } });
        return { net: 0.31 };
      },
      equityCurve: (limit) => {
        calls.push({ tool: 'get_equity_curve', args: { limit } });
        return { points: limit };
      },
      experiments: (limit) => {
        calls.push({ tool: 'get_experiments', args: { limit } });
        return { rows: limit };
      },
      lessons: (limit) => {
        calls.push({ tool: 'get_lessons', args: { limit } });
        return { rows: limit };
      },
      recentDecisions: (limit) => {
        calls.push({ tool: 'get_recent_decisions', args: { limit } });
        return { cycles: limit };
      },
      marketOverview: (limit) => {
        calls.push({ tool: 'get_market_overview', args: { limit } });
        return { symbols: limit };
      },
        skippedOutcomes: async () => ({ skipped: 0, symbols: [] }),
    },
    /* 测试要能看到 AI 改周期这件事 —— 与 pauses 同一个形状。 */
    cycleInterval: () => 3,
    setCycleInterval: (minutes) => { cycleIntervals.push(minutes); return { minutes, clamped: false }; },
    ...overrides,
  };

  return { deps, calls, saved, rejected, snapshot: () => current };
}

/* -------------------------------------------------------------------------- */
/*  参数校验                                                                   */
/* -------------------------------------------------------------------------- */

test('未知工具名返回错误而不是抛异常', async () => {
  /*
   * 幻觉出来的工具名不该让整个循环崩掉 —— 一轮循环里崩一次，
   * 后面所有工具调用都白做，而且 AI 拿不到"这个名字不存在"这个关键信息。
   */
  const { deps } = makeDeps();
  const out = await dispatchTool('set_levrage', { value: 10 }, deps);
  const result = out.result as { error: string };
  assert.match(result.error, /set_levrage/, '错误里必须点名它写错的那个，它才改得过来');
  assert.match(result.error, /set_params/, '必须列出可用工具');
});

test('缺必填参数时不执行工具，并把问题回报清楚', async () => {
  const { deps, saved } = makeDeps();
  const out = await dispatchTool('set_params', { patch: { coinSource: { coinPoolLimit: 5 } } }, deps);

  assert.match(JSON.stringify(out.result), /reason/, '必须点名缺的是 reason');
  assert.equal(saved.length, 0, '参数不合格时**绝不能**已经改动配置');
  assert.equal(out.patch, undefined, '没有执行就没有守卫结果');
});

test('数字参数拒绝字符串：悄悄转换会让一次参数错误变成看不见的行为差异', async () => {
  const { deps } = makeDeps();
  const out = await dispatchTool('get_experiments', { limit: '10' }, deps);
  assert.match(JSON.stringify(out.result), /必须是有限数字/);
});

test('越界的数字被拒绝，而不是被截断', async () => {
  /*
   * 截断是错的：模型传 limit=99999 而实际用 30，它会对"我只看到 30 条"
   * 这个事实一无所知，于是基于一个它以为完整的结果继续推理。
   */
  const { deps } = makeDeps();
  const out = await dispatchTool('get_experiments', { limit: 99999 }, deps);
  assert.match(JSON.stringify(out.result), /不得大于 30/);
  assert.match(JSON.stringify(out.result), /99999/, '要把它给的值原样报回去');
});

test('非法枚举值被拒绝并列出去可用值', async () => {
  const { deps } = makeDeps();
  const out = await dispatchTool('get_performance', { window: '1y' }, deps);
  assert.match(JSON.stringify(out.result), /24h/);
  assert.match(JSON.stringify(out.result), /1y/);
});

test('未给的选填参数用声明里的默认值', () => {
  const { deps, calls } = makeDeps();
  dispatchTool('get_performance', {}, deps);
  assert.deepEqual(calls, [{ tool: 'get_performance', args: { window: '24h' } }]);
});

test('参数不是对象时被拒绝 —— 但 null/undefined 宽容地当成"无参数"', async () => {
  /*
   * 分层是刻意的（§2.4：对结构宽容、对语义严格）：
   * 模型调一个无参工具时可能给 `null`、可能干脆省略，那**不是错误**，
   * 不该让它白跑一轮。但给一个数字、字符串或数组当参数就是真的错了。
   */
  for (const bad of [null, undefined]) {
    const { deps } = makeDeps();
    const out = await dispatchTool('get_performance', bad, deps);
    assert.equal((out.result as { net?: number }).net, 0.31, `${String(bad)} 应当被当成无参数并正常执行`);
  }

  for (const bad of [42, 'x', []]) {
    const { deps } = makeDeps();
    const out = await dispatchTool('get_performance', bad, deps);
    assert.match(JSON.stringify(out.result), /必须是一个对象/, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('validateArgs 直接可用：合法参数原样通过', () => {
  const spec = AGENT_TOOLS.find((t) => t.name === 'set_params')!;
  const r = validateArgs(spec, { patch: { a: 1 }, reason: '因为实测手续费吃掉了利润' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.reason, '因为实测手续费吃掉了利润');
});

/* -------------------------------------------------------------------------- */
/*  分发行为                                                                   */
/* -------------------------------------------------------------------------- */

test('set_params 过守卫：越界被整体拒绝，且配置一个字段都没动', async () => {
  const { deps, saved, rejected, snapshot } = makeDeps();
  const before = snapshot();

  const out = await dispatchTool(
    'set_params',
    { patch: { riskControl: { btcEthMaxLeverage: 9999 } }, reason: '想加大杠杆' },
    deps,
  );

  const result = out.result as { applied: boolean; rejected: string | null };
  assert.equal(result.applied, false);
  assert.ok(result.rejected, '必须把拒绝原因回报给模型');
  assert.equal(saved.length, 0, '被拒绝时不得写回配置');
  assert.deepEqual(snapshot(), before, '被拒绝时配置必须原封不动');
  /*
   * ⚠️ **但必须留一条记录。**
   *
   * 上面两条断言的是"配置没被改"，而这一条断言的是"AI 下次还看得到这次尝试" ——
   * 它们是两件事，第一版把它们合成了一句"被拒时不落库"，于是
   * `get_experiments` 里查不到被拒的补丁，AI 会重复同一个不可能通过的改动。
   * 一个只记录成功的实验日志，训练不出"什么不能做"那一半的知识。
   */
  assert.equal(rejected.length, 1, '被拒绝也要留一条记录 —— 否则 AI 看不到自己试过什么');
  assert.equal(rejected[0]!.rejected, result.rejected);
});

test('set_params 生效时把守卫结果带出来（含被钳制的项）', async () => {
  const { deps, saved } = makeDeps();

  const out = await dispatchTool(
    'set_params',
    {
      patch: { riskControl: { requireStopLoss: false }, coinSource: { coinPoolLimit: 7 } },
      reason: '想放宽入场',
    },
    deps,
  );

  assert.equal(saved.length, 1, '生效时必须落库一次');
  assert.equal((out.result as { applied: boolean }).applied, true);
  assert.equal(out.patch?.clamps.length, 1, '被钳制的项必须回喂 —— 否则 AI 会以为自己改成了');

  const savedConfig = saved[0]!.patch;
  assert.deepEqual(savedConfig, { riskControl: { requireStopLoss: false }, coinSource: { coinPoolLimit: 7 } });
  // 实际生效的配置里 requireStopLoss 必须还是真
  assert.equal(deps.currentConfig().riskControl.requireStopLoss, true);
  assert.equal(deps.currentConfig().coinSource.coinPoolLimit, 7);
});

test('set_params 之后的 get_current_params 看到的是**实际生效**的值', async () => {
  /*
   * 这一条是"钳制必须回喂"的另一半：AI 改完再看一眼，看到的必须是真值。
   * 如果它看到的是自己提交的那份，它会以为自己成功了。
   */
  const { deps } = makeDeps();
  dispatchTool(
    'set_params',
    { patch: { riskControl: { requireStopLoss: false } }, reason: 'x' },
    deps,
  );
  const seen = (await dispatchTool('get_current_params', {}, deps)).result as StrategyConfig;
  assert.equal(seen.riskControl.requireStopLoss, true);
});

test('★ get_skipped_outcomes 是异步的，并把结果原样交给 AI', async () => {
  /*
   * 这条用例存在的理由：**它是 AI 唯一能校准入场标准的反馈。**
   *
   * 模型每轮把候选池里绝大多数标的否掉，而它从来不知道那些标的后来的走势 ——
   * 于是它的入场标准（`minRiskRewardRatio`、`minScore`、它自己写的 `entryStandards`）
   * 永远得不到检验。它自己在一轮审视里明确点出了这个缺口：
   * 「minScore 我**没有任何'被滤掉的标的后来是否走了行情'的数据，无依据不动**」。
   *
   * 断言两件事：
   *  1. 它是**异步**的（唯一需要网络往返的只读工具，因此也是唯一被 `await` 的）；
   *  2. 返回值**原样**交给模型 —— 不做二次加工，尤其是**不能把 null 换成 0**：
   *     取不到价格与"价格没变"是两回事，混在一起会让模型在错的样本上做判断。
   */
  const { deps } = makeDeps();
  const seen = (await dispatchTool('get_skipped_outcomes', { cycles: 5 }, deps)).result as {
    skipped: number;
    symbols: Array<{ symbol: string; changePercent: number | null }>;
  };
  assert.equal(typeof seen.skipped, 'number');
  assert.ok(Array.isArray(seen.symbols));
});

  /*
   * ## 这条用例在 2026-10-04 被【改写】了，原契约是错的
   *
   *
   * ```ts
   * assert.ok(!AGENT_TOOLS.some((t) => /resume/i.test(t.name)),
   *   '不存在「恢复交易」的工具 —— 恢复是操作员的决定，不是模型的');
   * ```
   *
   * **那个前提与本系统的定位冲突。** 用户的原话：
   *
   * > 「**智能托管不需要人工干预，别给我画蛇添足整这些按钮出来，
   * >  智能托管就是完全交给 AI 操作，AI 要能 24 小时全自动交易**」
   *
   * 后果也不是理论上的：开关**只能设不能撤**，机器人永久停在新仓之外，
   * 而它自己还不知道（提示词里没告诉它），每轮仍在建议开仓 ——
   * 页面于是同时显示「开多」与「本轮不开新仓」。
   *
   * 而**风控边界仍然只能收紧**（`set_params` 那条没变）——
   * 停手是 AI 的自我约束，不是一道操作员的锁。
   */

test('finish 带上结论并终止本轮', async () => {
  const { deps } = makeDeps();
  const out = await dispatchTool('finish', { summary: '这轮什么都不改' }, deps);
  assert.equal(out.finished?.summary, '这轮什么都不改');
});

test('结果过长时截断，并**说明**截断了', async () => {
  /*
   * 静默截断比不截断更糟：模型会以为自己看到了全部，然后基于一个残缺的
   * 图景下结论。所以截断必须自己说出来。
   *
   * ⚠️ **长度要跟着 `MAX_JSON_CHARS` 走**：截断线从 6000 提到 40000 之后，
   * 原来那个 20000 字符的 blob 够不到线，这条用例就测不到东西了。
   */
  const { deps } = makeDeps({
    read: {
      performance: () => ({ blob: 'x'.repeat(60_000) }),
      equityCurve: () => [],
      experiments: () => [],
      lessons: () => [],
      recentDecisions: () => [],
      marketOverview: () => [],
      skippedOutcomes: async () => ({}),
    },
  });
  const out = (await dispatchTool('get_performance', {}, deps)).result as {
    truncated?: boolean;
    note?: string;
    original_length?: number;
  };
  assert.equal(out.truncated, true);
  assert.match(out.note ?? '', /截断/, '必须说明被截断了');
  /*
   * ⚠️ **`preview` 是字符切片，通常在 JSON 中间断开。**
   *
   * 模型拿到一段以 `,{"id":31,"sym` 结尾的文本时，如果以为那是一个对象，
   * 它会把解析失败归因于自己。所以说明里必须点出这一点 —— 它才知道该做的是
   * "缩小 limit 再取一次"，而不是"我读不懂"。
   */
  assert.match(out.note ?? '', /不要把它当成可解析的 JSON/, '必须说清 preview 不是合法 JSON');
  assert.match(out.note ?? '', /limit/, '要给出可执行的下一步');
  assert.ok(
    (out.original_length ?? 0) > 60_000,
    '要报出原始长度，模型才能判断"差多少"',
  );
});

/* -------------------------------------------------------------------------- */
/*  清单本身                                                                   */
/* -------------------------------------------------------------------------- */

test('工具清单：说明写给模型看，且都非空', () => {
  for (const tool of AGENT_TOOLS) {
    assert.ok(tool.describe.length > 20, `${tool.name} 的说明太短，模型无法判断何时该用它`);
    for (const [name, spec] of Object.entries(tool.args)) {
      assert.ok(spec.describe.length > 0, `${tool.name}.${name} 缺说明`);
    }
  }
});

test('★ 基准不在名字里的参数必须给出解释，而不是让 AI 去猜', () => {
  /*
   * 实测：一次真实的策略审视里，AI 把 `minStopLossFeeMultiple` 从 3 改成 6，
   * 然后在 reason 里写下：
   *
   *   「不确定项已标注：该乘数的基准我只能从命名与 fallbackRoundTripFeeRate 推断为
   *     往返费；**若实际按单边费计，本次改动几乎空转**」
   *
   * 它的推断**是对的**，但**它本不该猜** —— 那个定义写在交易员的提示词里，
   * 策略师只拿得到配置对象。而基准差一倍、目标值就差一倍：猜错的代价是
   * AI 照着一个错前提调参，并在下一轮把它当成已验证的事实。
   */
  const c = defaultStrategyConfig();
  const derived = derivedRiskFigures(c);
  const note = derived['riskControl.minStopLossFeeMultiple'] ?? '';

  assert.match(note, /往返/, '必须点明基准是往返费');
  assert.match(note, /不是单边/, '必须排除"单边"这个同样合理的读法');

  /*
   * 光有定义还不够：AI 要拿它判断"这个门槛在当前波动下是否可达"，
   * 所以折算出来的**具体百分比**必须真的算在返回里。
   */
  const risk = c.riskControl;
  const expected = (risk.fallbackRoundTripFeeRate * risk.minStopLossFeeMultiple * 100).toFixed(3);
  assert.ok(
    note.includes(expected),
    `必须给出折算后的门槛（期望包含 ${expected}%），实际：${note}`,
  );
});

test('get_lessons 把复盘教训交给 AI —— 复盘能影响决策的唯一通路', async () => {
  /*
   * 为什么这条必须有：`agent_memory` 原本**只有一个出口** —— 复盘时按标的检索、
   * 喂给复盘员自己（`forSymbol`）。也就是说"这笔为什么亏"的结论**永远到不了
   * 做决策的策略师**。`agentMemory.recent()` 的注释写着"用于让模型看到最近学到了
   * 什么"，而它的唯一调用者在测试里。
   *
   * 实测后果：复盘员在不同标的上反复打出「止损过紧」「离场不锁盈」「费用吃掉利润」，
   * 而策略师在同一段时间里**一直在 minPositionSize 上反复微调**（12→6→6→5.5→5.1，
   * 五次，每次理由都是同一句"账户太小"）—— 因为它看不到那个诊断。
   */
  const { deps } = makeDeps();
  const out = await dispatchTool('get_lessons', { limit: 5 }, deps);
  assert.deepEqual(out.result, { rows: 5 }, '必须真的走到 read.lessons，并把 limit 透传下去');
});

test('★ set_params 必须明说「规则可以删」—— 只说 change 是不够的', () => {
  /*
   * ## 用户 2026-10-02 的判断
   *
   *   「越更新迭代，感觉系统问题越多，越不智能越来不可用」
   *   「还不如刚做智能模式第一版，虽然 BUG 问题很多，但起码有惊喜」
   *
   * 而数据支持这句话里最要紧的那一半 —— **它自己写的规则只增不减**：
   *
   *     09-20 13:12      78 字符
   *     09-21 02:22     794 字符   ← 开单率 20%、净 +1.22（"有惊喜"的那几天）
   *     09-27 01:26   5,080 字符   ← 开单率 58%
   *     09-30 08:19   6,999 字符   ← 开单率 8%，此后连续 11 轮全 skip
   *
   * 它不删的原因是**理性**的：每一条规则都来自一次真实亏损，删掉它感觉像放松风控。
   * 缺的不是意愿，是**许可** —— 这段工具说明原来只有 "if it no longer fits the market,
   * change it"，**从来没有说过"那是一整段替换，所以你可以删"**。
   *
   * 所以这条用例钉住三件事：
   *   1. 说明里明确"整段替换"（否则它以为只能追加）；
   *   2. 说明里明确"删规则是合法且被期待的"；
   *   3. 同时点明"硬上限由代码强制、与它写什么无关" —— 否则它会把"删规则"
   *      误读成"放松风控"，而那正是它一直不敢删的原因。
   */
  const spec = AGENT_TOOLS.find((t) => t.name === 'set_params');
  assert.ok(spec, 'set_params 必须还在工具清单里');
  const text = spec.describe;

  assert.match(text, /REPLACED WHOLE|full replacement/i, '★ 要说清 promptSections 是整段替换');
  assert.match(text, /DELETE|delete|drop what/i, '★ 要明确"删"是合法动作');
  assert.match(
    text,
    /code-enforced|unaffected by anything you write/i,
    '要说明硬上限由代码强制 —— 否则它把"删规则"误读成"放松风控"',
  );
});

test('renderToolCatalogue 会把每个工具与参数都渲染出来', () => {
  const text = renderToolCatalogue();
  for (const tool of AGENT_TOOLS) {
    assert.match(text, new RegExp(`### ${tool.name}`), `${tool.name} 没出现在清单里`);
  }
  assert.match(text, /必填/, '必填标记必须渲染出来');
});

test('set_cycle_interval 会落库、钳制越界值、并回喂实际值', async () => {
  /*
   * 这条钉住三件事，每一件都有具体的失效方式：
   *
   *  1. **落库** —— 只记在内存里的话，进程重启就回到旧值，
   *     而 AI 会以为自己调过。决策周期是调度器每轮要读的，必须在库里。
   *  2. **钳制越界** —— 0 或 100000 这种值会让调度器空转或永远不醒。
   *  3. **回喂实际值** —— 与 set_params 的 clamps 同一个理由：
   *     AI 以为改成了 0.5、实际是 1 的话，下一轮它会基于错误前提推理。
   */
  const applied: Array<{ minutes: number; reason: string }> = [];
  const { deps } = makeDeps({
    setCycleInterval: (minutes, reason) => {
      const clamped = Math.min(1440, Math.max(1, Math.round(minutes)));
      applied.push({ minutes: clamped, reason });
      return { minutes: clamped, clamped: clamped !== minutes };
    },
  });

  const ok = await dispatchTool('set_cycle_interval', { minutes: 7, reason: '行情快' }, deps);
  assert.equal(applied.at(-1)?.minutes, 7, '正常值应当原样落库');
  assert.equal((ok.result as { clamped: boolean }).clamped, false);

  /*
   * 越界值走的是**参数校验**那条路，不是实现里的钳制 ——
   * 工具声明里写了 `min: 1, max: 1440`，`validateArgs` 先把它拦下来。
   * （实现里那一层 `Math.min/max` 是第二道保险，覆盖"校验被绕过"的情况。）
   */
  const tooSmall = await dispatchTool('set_cycle_interval', { minutes: 0.2, reason: '想更快' }, deps);
  assert.notEqual(tooSmall.result, undefined, '越界值不该静默通过');
  const rejectedText = JSON.stringify(tooSmall.result);
  assert.match(rejectedText, /min|1|范围|超出/, `越界值必须被拒绝并说清原因，实际：${rejectedText}`);
  assert.equal(applied.length, 1, '被拒绝的调用不该落到实现里');

  /*
   * 而上限那一侧同样要被拦住 —— `0` 会让调度器空转，
   * `100000` 等于永不醒来。两种都是真实的失效方式。
   */
  const tooBig = await dispatchTool('set_cycle_interval', { minutes: 100000, reason: '想更慢' }, deps);
  assert.match(JSON.stringify(tooBig.result), /max|1440|范围|超出/);
  assert.equal(applied.length, 1, '被拒绝的调用不该落到实现里');
});

test('get_current_params 必须带上决策周期 —— 否则 AI 不知道起点', async () => {
  /*
   * 决策周期不在 StrategyConfig 里（是 traders 表上的一列），
   * 所以第一版这个工具读不到它 —— AI 想调频率时不知道自己现在是多少，
   * 只能瞎猜一个数。**不知道起点就没法判断该往哪边调。**
   */
  const { deps } = makeDeps({ cycleInterval: () => 7 });
  const out = await dispatchTool('get_current_params', {}, deps);
  assert.equal(
    (out.result as { cycleIntervalMinutes: number }).cycleIntervalMinutes,
    7,
    '当前参数里必须能看到决策周期',
  );
});