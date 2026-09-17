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

import { AGENT_TOOLS, dispatchTool, renderToolCatalogue, validateArgs, type AgentToolDeps } from './tools.js';

const config = (): StrategyConfig =>
  StrategyConfigSchema.parse({
    ...defaultStrategyConfig(),
    ...(STRATEGY_PRESETS[0]?.patch as Partial<StrategyConfig>),
  }) as StrategyConfig;

/** 一个把读工具全部记账的桩：要断言"到底调没调、用的是什么参数"。 */
function makeDeps(overrides: Partial<AgentToolDeps> = {}) {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const saved: Array<{ reason: string; patch: unknown; clamps: unknown }> = [];
  const pauses: string[] = [];
  let current = config();

  const deps: AgentToolDeps = {
    currentConfig: () => current,
    saveConfig: (next, context) => {
      current = next;
      saved.push(context);
    },
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
      recentDecisions: (limit) => {
        calls.push({ tool: 'get_recent_decisions', args: { limit } });
        return { cycles: limit };
      },
      marketOverview: (limit) => {
        calls.push({ tool: 'get_market_overview', args: { limit } });
        return { symbols: limit };
      },
    },
    requestPause: (reason) => pauses.push(reason),
    ...overrides,
  };

  return { deps, calls, saved, pauses, snapshot: () => current };
}

/* -------------------------------------------------------------------------- */
/*  参数校验                                                                   */
/* -------------------------------------------------------------------------- */

test('未知工具名返回错误而不是抛异常', () => {
  /*
   * 幻觉出来的工具名不该让整个循环崩掉 —— 一轮循环里崩一次，
   * 后面所有工具调用都白做，而且 AI 拿不到"这个名字不存在"这个关键信息。
   */
  const { deps } = makeDeps();
  const out = dispatchTool('set_levrage', { value: 10 }, deps);
  const result = out.result as { error: string };
  assert.match(result.error, /set_levrage/, '错误里必须点名它写错的那个，它才改得过来');
  assert.match(result.error, /set_params/, '必须列出可用工具');
});

test('缺必填参数时不执行工具，并把问题回报清楚', () => {
  const { deps, saved } = makeDeps();
  const out = dispatchTool('set_params', { patch: { coinSource: { coinPoolLimit: 5 } } }, deps);

  assert.match(JSON.stringify(out.result), /reason/, '必须点名缺的是 reason');
  assert.equal(saved.length, 0, '参数不合格时**绝不能**已经改动配置');
  assert.equal(out.patch, undefined, '没有执行就没有守卫结果');
});

test('数字参数拒绝字符串：悄悄转换会让一次参数错误变成看不见的行为差异', () => {
  const { deps } = makeDeps();
  const out = dispatchTool('get_experiments', { limit: '10' }, deps);
  assert.match(JSON.stringify(out.result), /必须是有限数字/);
});

test('越界的数字被拒绝，而不是被截断', () => {
  /*
   * 截断是错的：模型传 limit=99999 而实际用 30，它会对"我只看到 30 条"
   * 这个事实一无所知，于是基于一个它以为完整的结果继续推理。
   */
  const { deps } = makeDeps();
  const out = dispatchTool('get_experiments', { limit: 99999 }, deps);
  assert.match(JSON.stringify(out.result), /不得大于 30/);
  assert.match(JSON.stringify(out.result), /99999/, '要把它给的值原样报回去');
});

test('非法枚举值被拒绝并列出去可用值', () => {
  const { deps } = makeDeps();
  const out = dispatchTool('get_performance', { window: '1y' }, deps);
  assert.match(JSON.stringify(out.result), /24h/);
  assert.match(JSON.stringify(out.result), /1y/);
});

test('未给的选填参数用声明里的默认值', () => {
  const { deps, calls } = makeDeps();
  dispatchTool('get_performance', {}, deps);
  assert.deepEqual(calls, [{ tool: 'get_performance', args: { window: '24h' } }]);
});

test('参数不是对象时被拒绝 —— 但 null/undefined 宽容地当成"无参数"', () => {
  /*
   * 分层是刻意的（§2.4：对结构宽容、对语义严格）：
   * 模型调一个无参工具时可能给 `null`、可能干脆省略，那**不是错误**，
   * 不该让它白跑一轮。但给一个数字、字符串或数组当参数就是真的错了。
   */
  for (const bad of [null, undefined]) {
    const { deps } = makeDeps();
    const out = dispatchTool('get_performance', bad, deps);
    assert.equal((out.result as { net?: number }).net, 0.31, `${String(bad)} 应当被当成无参数并正常执行`);
  }

  for (const bad of [42, 'x', []]) {
    const { deps } = makeDeps();
    const out = dispatchTool('get_performance', bad, deps);
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

test('set_params 过守卫：越界被整体拒绝，且配置一个字段都没动', () => {
  const { deps, saved, snapshot } = makeDeps();
  const before = snapshot();

  const out = dispatchTool(
    'set_params',
    { patch: { riskControl: { btcEthMaxLeverage: 9999 } }, reason: '想加大杠杆' },
    deps,
  );

  const result = out.result as { applied: boolean; rejected: string | null };
  assert.equal(result.applied, false);
  assert.ok(result.rejected, '必须把拒绝原因回报给模型');
  assert.equal(saved.length, 0, '被拒绝时不得落库');
  assert.deepEqual(snapshot(), before, '被拒绝时配置必须原封不动');
});

test('set_params 生效时把守卫结果带出来（含被钳制的项）', () => {
  const { deps, saved } = makeDeps();

  const out = dispatchTool(
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

test('set_params 之后的 get_current_params 看到的是**实际生效**的值', () => {
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
  const seen = dispatchTool('get_current_params', {}, deps).result as StrategyConfig;
  assert.equal(seen.riskControl.requireStopLoss, true);
});

test('pause_trading 只收紧，且没有反向工具', () => {
  const { deps, pauses } = makeDeps();
  const out = dispatchTool('pause_trading', { reason: '市场在横盘，等信号' }, deps);

  assert.deepEqual(pauses, ['市场在横盘，等信号']);
  assert.match(JSON.stringify(out.result), /只能收紧/);
  assert.ok(
    !AGENT_TOOLS.some((t) => /resume/i.test(t.name)),
    '不存在「恢复交易」的工具 —— 恢复是操作员的决定，不是模型的',
  );
});

test('finish 带上结论并终止本轮', () => {
  const { deps } = makeDeps();
  const out = dispatchTool('finish', { summary: '这轮什么都不改' }, deps);
  assert.equal(out.finished?.summary, '这轮什么都不改');
});

test('结果过长时截断，并**说明**截断了', () => {
  /*
   * 静默截断比不截断更糟：模型会以为自己看到了全部，然后基于一个残缺的
   * 图景下结论。所以截断必须自己说出来。
   */
  const { deps } = makeDeps({
    read: {
      performance: () => ({ blob: 'x'.repeat(20000) }),
      equityCurve: () => [],
      experiments: () => [],
      recentDecisions: () => [],
      marketOverview: () => [],
    },
  });
  const out = dispatchTool('get_performance', {}, deps).result as { truncated?: boolean; note?: string };
  assert.equal(out.truncated, true);
  assert.match(out.note ?? '', /截断/, '必须说明被截断了');
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

test('renderToolCatalogue 会把九个工具与参数都渲染出来', () => {
  const text = renderToolCatalogue();
  for (const tool of AGENT_TOOLS) {
    assert.match(text, new RegExp(`### ${tool.name}`), `${tool.name} 没出现在清单里`);
  }
  assert.match(text, /必填/, '必填标记必须渲染出来');
});
